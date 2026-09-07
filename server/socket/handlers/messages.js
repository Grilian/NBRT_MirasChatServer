// Сообщения: отправка, правка, удаление.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.
const db = require('../../db');
const { isParticipant, participantsForChatId } = require('../../services/chatParticipants');
const { canPostToGroup } = require('../../services/chatPermissions');
const { isValidChatFilePath, isValidChatImagePath } = require('../../routes/messages');
const { NotificationPolicyError, resolveForceNotification, shouldNotifyUser } = require('../../services/notificationPolicy');
const { PollError, insertPoll, normalizePollDraft, serializePoll } = require('../../services/polls');
const { listRecentChats } = require('../../services/recentChats');
const { trimDanglingShortcode } = require('../../utils/shortcode');
const { hideThread, softDeleteThread } = require('../../services/threads');
const { MAX_MESSAGE_LENGTH, MUTE_EXEMPT_GROUPS, canDeleteForEveryone, clientIpOf, isAnnouncementChat, isFlooding, replyPreviewOf } = require('../chatHelpers');
const { canReceiveInApp, isUserOnline, schedulePush } = require('../presence');

function register(socket, ctx) {
  const { io, emitToChat } = ctx;

  socket.on('chat_message', async (rawData, ack) => {
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    let acknowledged = false;
    const respond = (payload) => {
      if (acknowledged || typeof ack !== 'function') return;
      acknowledged = true;
      ack(payload);
    };
    // Не доверяем data.senderId — это просто то, что прислал клиент, и его
    // легко подделать. Единственный источник истины — socket.userId,
    // выставленный сервером при аутентифицированном 'user_online'.
    const senderId = socket.userId;
    if (!senderId) { respond({ ok: false, error: 'auth_required' }); return; }

    // Старые клиенты этого поля не присылают и продолжают работать. Для
    // новых оно является ключом идемпотентности: повтор после потерянного ack
    // должен подтвердить исходную запись, а не вставить вторую.
    const clientMessageId = data.clientMessageId === undefined || data.clientMessageId === null
      ? null
      : String(data.clientMessageId);
    if (clientMessageId && !/^[a-zA-Z0-9_-]{16,100}$/.test(clientMessageId)) {
      respond({ ok: false, error: 'invalid_client_message_id' });
      return;
    }

    // Пишем только в чат, где отправитель реально участник — раньше это никак
    // не проверялось, и любой мог отправить сообщение в chat_<a>_<b> чужих
    // пользователей, просто зная их id.
    if (!isParticipant(data.chatId, senderId)) { respond({ ok: false, error: 'chat_forbidden' }); return; }

    if (clientMessageId) {
      const existing = db.prepare(`
        SELECT id, created_at
        FROM messages
        WHERE sender_id = ? AND client_message_id = ?
      `).get(senderId, clientMessageId);
      if (existing) {
        respond({
          ok: true,
          messageId: Number(existing.id),
          clientMessageId,
          createdAt: existing.created_at,
          deduplicated: true,
        });
        return;
      }
    }

    // «Кто может писать» — единый механизм прав (services/chatPermissions.js).
    // Проверка обязательна здесь: дизейбл композера на клиенте только для
    // удобства, обойти его тривиально.
    const groupMatch = String(data.chatId).match(/^group_(\d+)$/);
    if (groupMatch && !canPostToGroup(Number(groupMatch[1]), senderId)) {
      socket.emit('message_blocked', { reason: 'write_not_allowed', chatId: data.chatId });
      respond({ ok: false, error: 'write_not_allowed' });
      return;
    }

    // Текст раньше уходил в БД как есть, что бы клиент ни прислал: пустая
    // строка, null или мегабайтная простыня одинаково создавали запись. Пустые
    // сообщения замусоривали превью в списке чатов, а длинные — разъезжались
    // по вёрстке у всех участников.
    let pollDraft = null;
    if (data.poll !== undefined && data.poll !== null) {
      try {
        pollDraft = normalizePollDraft(data.poll);
      } catch (e) {
        socket.emit('poll_error', {
          code: e instanceof PollError ? e.code : 'invalid_poll',
          message: e.message || 'Не удалось создать опрос',
        });
        respond({ ok: false, error: e instanceof PollError ? e.code : 'invalid_poll' });
        return;
      }
    }

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    // Стикер сам себе довольно — без подписи, как и опрос без картинки:
    // проверяем запрос на стикер ДО финального текста, чтобы случайно
    // прицепленный текст не осел рядом с ним в БД.
    const stickerRequested = Number.isInteger(Number(data.stickerId));
    // Обрезка не должна разрубить код кастомного смайлика: огрызок ":cat" уже
    // не станет картинкой и остался бы в БД навсегда техническим текстом.
    // Клиент режет текст сам, но его обрезку можно обойти — это последняя линия.
    // Обрезка хвоста — общим шаблоном (utils/shortcode.js): две разъехавшиеся
    // копии этого правила и были причиной бага с кодом `:e~<ключ>~<пак>:`.
    const finalText = pollDraft
      ? pollDraft.question
      : stickerRequested
        ? ''
        : (text.length > MAX_MESSAGE_LENGTH
          ? trimDanglingShortcode(text.slice(0, MAX_MESSAGE_LENGTH))
          : text);

    // Картинка приходит уже загруженной отдельным REST-запросом (см.
    // POST /api/messages/upload-image) — сюда попадает только путь к ней.
    // Доверять пути от клиента нельзя: без проверки можно было бы подсунуть
    // произвольный /uploads/... файл чужого назначения. isValidChatImagePath
    // сверяет и формат пути, и то, что файл реально существует на диске.
    const hasImage = !pollDraft && typeof data.filePath === 'string' && isValidChatImagePath(data.filePath);
    const filePath = hasImage ? data.filePath : null;
    const fileWidth = hasImage && Number.isFinite(Number(data.fileWidth)) ? Number(data.fileWidth) : null;
    const fileHeight = hasImage && Number.isFinite(Number(data.fileHeight)) ? Number(data.fileHeight) : null;

    // Стикер — самостоятельный тип сообщения, исключает и текст, и картинку.
    // Клиент присылает только id уже существующего элемента пака — сам
    // стикер грузится заранее через админку, а не в момент отправки,
    // поэтому здесь просто проверка по базе, а не файл.
    const hasSticker = !pollDraft && !hasImage && stickerRequested;
    const stickerRow = hasSticker
      ? db.prepare('SELECT id, emoji FROM sticker_items WHERE id = ?').get(Number(data.stickerId))
      : null;
    const stickerId = stickerRow ? stickerRow.id : null;
    const stickerFallback = stickerRow ? stickerRow.emoji : null;

    // Файл приходит уже загруженным отдельным REST-запросом (POST
    // /api/messages/upload-file), сюда попадает только путь — и доверять
    // ему нельзя ровно по той же причине, что и пути картинки.
    // К файлу подпись РАЗРЕШЕНА (в отличие от стикера): подписать документ
    // «вот смета за август» — обычное дело.
    const hasDocument = !pollDraft && !hasImage && !stickerId
      && typeof data.documentPath === 'string' && isValidChatFilePath(data.documentPath);
    const documentPath = hasDocument ? data.documentPath : null;
    const documentName = hasDocument && typeof data.documentName === 'string'
      ? data.documentName.slice(0, 200)
      : null;
    const documentSize = hasDocument && Number.isFinite(Number(data.documentSize))
      ? Number(data.documentSize)
      : null;
    const documentMime = hasDocument && typeof data.documentMime === 'string'
      ? data.documentMime.slice(0, 120)
      : null;

    // Сообщение без текста, картинки, стикера и файла — отправлять нечего.
    if (!finalText && !filePath && !stickerId && !documentPath) {
      respond({ ok: false, error: 'empty_message' });
      return;
    }

    // Ответ: id принимаем только если это сообщение существует и лежит в ЭТОМ
    // же чате — иначе цитатой можно было бы вытащить кусок чужой переписки,
    // просто подставив её id (клиент показывает текст исходного сообщения).
    const replyToId = !pollDraft && Number.isInteger(Number(data.replyToId)) && Number(data.replyToId) > 0
      ? Number(data.replyToId)
      : null;
    const replySource = replyToId
      ? db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(replyToId, data.chatId)
      : null;
    const finalReplyTo = replySource ? replyToId : null;

    // Пересылка: подпись «переслано от кого» — снимок имени, а не ссылка.
    // Доверять тут нечему по существу (это просто подпись), но обрезаем длину,
    // чтобы в базу не уехала простыня.
    const forwardedFromName = typeof data.forwardedFromName === 'string' && data.forwardedFromName.trim()
      ? data.forwardedFromName.trim().slice(0, 100)
      : null;
    const forwardedFromChat = typeof data.forwardedFromChat === 'string' && data.forwardedFromChat.trim()
      ? data.forwardedFromChat.trim().slice(0, 100)
      : null;

    if (isFlooding(socket)) {
      socket.emit('message_blocked', { reason: 'rate_limit', chatId: data.chatId });
      respond({ ok: false, error: 'rate_limit' });
      return;
    }

    // Режим тишины — проверяем по аутентичному senderId, а не по тому, что
    // прислал клиент. Заодно берём имя — раньше отправленное сообщение
    // вообще не несло имени отправителя, и в общем чате живые сообщения не
    // могли показать, кто написал (клиент брал его из payload, которого не было).
    const senderRow = db.prepare('SELECT username, display_name, muted FROM users WHERE id = ?').get(senderId);
    if (senderRow && senderRow.muted) {
      // Исключение: даже в режиме тишины можно писать конкретным людям из
      // групп "Администрация"/"Админы" — это не про рассылку (general
      // остаётся заблокирован), а про обращение к администрации напрямую.
      let muteExempt = false;
      const participants = participantsForChatId(data.chatId);
      if (participants && participants.length === 2) {
        const otherId = participants.find((pid) => pid !== senderId);
        const otherGroup = db.prepare(
          'SELECT g.name FROM users u LEFT JOIN groups g ON g.id = u.group_id WHERE u.id = ?'
        ).get(otherId);
        muteExempt = !!(otherGroup && MUTE_EXEMPT_GROUPS.includes(otherGroup.name));
      }

      if (!muteExempt) {
        socket.emit('message_blocked', { reason: 'muted', chatId: data.chatId });
        respond({ ok: false, error: 'muted' });
        return;
      }
    }

    try {
      const forceNotification = resolveForceNotification(senderId, data.forceNotification === true);
      // Сохраняем в локальную БД
      const stmt = db.prepare(`
        INSERT INTO messages
          (chat_id, sender_id, text, file_path, file_width, file_height, status, sender_ip,
           reply_to_id, forwarded_from_name, forwarded_from_chat, client_message_id, force_notification,
           sticker_id, sticker_fallback, document_path, document_name, document_size, document_mime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Сообщение и опрос — одна атомарная операция: нельзя оставить в ленте
      // текст вопроса без вариантов, если вставка опроса оборвалась.
      const persist = db.transaction(() => {
        const result = stmt.run(
          data.chatId, senderId, finalText, filePath, fileWidth, fileHeight, 'sent', clientIpOf(socket),
          finalReplyTo, forwardedFromName, forwardedFromChat, clientMessageId, forceNotification ? 1 : 0,
          stickerId, stickerFallback, documentPath, documentName, documentSize, documentMime
        );
        const poll = pollDraft
          ? insertPoll(result.lastInsertRowid, data.chatId, senderId, pollDraft)
          : null;
        return { result, pollId: poll ? poll.id : null };
      });
      const { result, pollId } = persist();

      // После первой успешной отправки ранее сохранённое открытие становится
      // допустимым для «Недавних». Само время здесь не меняем: сортировка идёт
      // именно по открытию, а пересылка в «Избранное» без перехода туда не
      // должна поднимать его наверх. Событие получают все устройства аккаунта.
      io.to(`user:${senderId}`).emit('recent_chats_changed', listRecentChats(senderId));

      const message = {
        id: result.lastInsertRowid,
        chat_id: data.chatId,
        sender_id: senderId,
        text: finalText,
        file_path: filePath,
        file_width: fileWidth,
        file_height: fileHeight,
        sticker_id: stickerId,
        sticker_fallback: stickerFallback,
        document_path: documentPath,
        document_name: documentName,
        document_size: documentSize,
        document_mime: documentMime,
        status: 'sent',
        created_at: new Date().toISOString(),
        force_notification: forceNotification,
        username: senderRow ? senderRow.username : undefined,
        display_name: senderRow ? senderRow.display_name : undefined,
        // Отметка «просмотрено» — только в каналах-объявлениях. Ставим ноль
        // сразу при отправке, иначе счётчик появлялся бы у автора лишь после
        // перезагрузки истории (в живом событии поля просто не было).
        ...(isAnnouncementChat(data.chatId) ? { read_count: 0 } : {}),
        reply_to_id: finalReplyTo,
        // Цитату собираем здесь же: без неё живо пришедший ответ показывал бы
        // пустую полоску до перезагрузки истории.
        ...(finalReplyTo ? replyPreviewOf(finalReplyTo) : {}),
        forwarded_from_name: forwardedFromName,
        forwarded_from_chat: forwardedFromChat,
        client_message_id: clientMessageId,
        ...(pollId ? { poll: serializePoll(pollId, senderId) } : {}),
      };

      emitToChat(data.chatId, 'chat_message', message, senderId);
      // Подтверждаем сразу после атомарной записи и живой рассылки. Ошибка
      // вторичного пуш-уведомления не должна заставлять клиента повторно
      // создать уже существующий опрос.
      respond({
        ok: true,
        messageId: Number(result.lastInsertRowid),
        clientMessageId,
        createdAt: message.created_at,
        pollId,
      });

      // Автоподписка: как только между двумя людьми реально пошли сообщения,
      // чат появляется в списке контактов у обеих сторон (не только у
      // отправителя, который мог сам явно добавить собеседника из справочника)
      // — иначе получатель первого сообщения просто не увидел бы новый чат.
      const participants = participantsForChatId(data.chatId);
      if (participants && participants.length === 2) {
        const [a, b] = participants;
        const insertContact = db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)');
        const changedA = insertContact.run(a, b).changes > 0;
        const changedB = insertContact.run(b, a).changes > 0;
        if (changedA) io.to('user:' + a).emit('contact_added', { withUserId: b });
        if (changedB) io.to('user:' + b).emit('contact_added', { withUserId: a });
      }

      // Кому нужен пуш. Признак тут НЕ «есть живой сокет», а «есть сокет,
      // способный показать уведомление сам» (canReceiveInApp): свёрнутое на
      // Android приложение сокет какое-то время держит, но JS в нём заморожен
      // и уведомление не нарисует — раньше в этой дырке пуш не уходил вовсе.
      // recipientOnline остаётся по isUserOnline: это про статус доставки
      // сообщения, а не про то, кто его сейчас увидит.
      let recipientOnline = false;
      const offlineRecipients = [];
      if (data.chatId === 'general') {
        const everyoneElse = db.prepare('SELECT id FROM users WHERE id != ?').all(senderId).map((r) => r.id);
        recipientOnline = everyoneElse.some((id) => isUserOnline(id));
        offlineRecipients.push(...everyoneElse.filter((id) => !canReceiveInApp(id)));
      } else if (/^group_\d+$/.test(data.chatId)) {
        const others = (participants || []).filter((id) => id !== senderId);
        recipientOnline = others.some((id) => isUserOnline(id));
        offlineRecipients.push(...others.filter((id) => !canReceiveInApp(id)));
      } else {
        const match = data.chatId.match(/^chat_(\d+)_(\d+)$/);
        if (match) {
          const otherId = Number(match[1]) === senderId ? Number(match[2]) : Number(match[1]);
          recipientOnline = isUserOnline(otherId);
          if (!canReceiveInApp(otherId)) offlineRecipients.push(otherId);
        }
      }

      // Пуш шлём именно тем, у кого нет живого сокета. Пока сокет жив, клиент
      // сам показывает уведомление по событию 'chat_message' — послать сюда
      // ещё и пуш означало бы две карточки на одно сообщение. Свёрнутое на
      // телефоне приложение выпадает из онлайна само по pingTimeout, так что
      // оно попадает в эту ветку.
      const senderName = senderRow ? (senderRow.display_name || senderRow.username) : undefined;
      // В общем чате и в группах у сообщения много получателей — заголовок
      // пуша должен показывать, откуда оно, иначе выглядит как личное
      // сообщение от этого человека, хотя видят его все.
      let chatLabel;
      if (data.chatId === 'general') {
        chatLabel = 'Общий чат';
      } else if (/^group_\d+$/.test(data.chatId)) {
        const group = db.prepare('SELECT name FROM chat_groups WHERE id = ?').get(data.chatId.slice('group_'.length));
        chatLabel = group ? group.name : undefined;
      }
      for (const userId of offlineRecipients.filter(
        (id) => shouldNotifyUser(id, data.chatId, forceNotification)
      )) {
        schedulePush(userId, {
          chatId: data.chatId,
          messageId: result.lastInsertRowid,
          senderName,
          chatLabel,
          forceNotification,
        // Сокет ещё жив — значит клиент может успеть показать уведомление сам
        // (см. schedulePush): ждём его подтверждения, прежде чем слать пуш.
        }, { defer: isUserOnline(userId) });
      }

      if (recipientOnline) {
        db.prepare('UPDATE messages SET status = ? WHERE id = ?').run('delivered', result.lastInsertRowid);
        message.status = 'delivered';
        emitToChat(data.chatId, 'message_status', { id: result.lastInsertRowid, status: 'delivered' }, senderId);
      }
    } catch (e) {
      // Две вкладки одного аккаунта могут одновременно восстановить одну и
      // ту же локальную очередь. Уникальный индекс остановит вторую вставку;
      // для клиента это успешный идемпотентный повтор, а не ошибка.
      if (clientMessageId) {
        const existing = db.prepare(`
          SELECT id, created_at
          FROM messages
          WHERE sender_id = ? AND client_message_id = ?
        `).get(senderId, clientMessageId);
        if (existing) {
          respond({
            ok: true,
            messageId: Number(existing.id),
            clientMessageId,
            createdAt: existing.created_at,
            deduplicated: true,
          });
          return;
        }
      }
      console.error('Ошибка:', e);
      if (pollDraft) {
        socket.emit('poll_error', {
          code: e instanceof PollError ? e.code : 'poll_create_failed',
          message: e.message || 'Не удалось создать опрос',
        });
      }
      respond({
        ok: false,
        error: e instanceof PollError || e instanceof NotificationPolicyError ? e.code : 'message_failed'
      });
    }
  });

  // Ответы ветки хранятся в той же таблице сообщений и используют те же
  // изображения, опросы, идемпотентность и права записи. Отличается только

  socket.on('message_edit', (data) => {
    try {
      const { id, text } = data && typeof data === 'object' ? data : {};
      const row = db.prepare(`
        SELECT m.chat_id, m.sender_id, m.deleted,
               EXISTS(SELECT 1 FROM polls p WHERE p.message_id = m.id) AS is_poll
        FROM messages m WHERE m.id = ?
      `).get(id);
      // Вопрос — часть структуры опроса, а не обычный редактируемый текст.
      // Старый клиент видит fallback-текст, но не должен рассинхронизировать
      // его с polls.question обходом нового интерфейса.
      if (!row || row.deleted || row.is_poll || Number(row.sender_id) !== Number(socket.userId)) return;

      const trimmed = String(text || '').trim();
      if (!trimmed) return;
      if (trimmed.length > MAX_MESSAGE_LENGTH) return;

      const editedAt = new Date().toISOString();
      db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(trimmed, editedAt, id);

      emitToChat(row.chat_id, 'message_edited', {
        id,
        chat_id: row.chat_id,
        text: trimmed,
        edited_at: editedAt
      }, row.sender_id);
    } catch (e) {
      console.error('Ошибка редактирования сообщения:', e);
    }
  });

  // "Удаление" — только флаг deleted: по закону нужно быть готовыми
  // предоставить всю переписку целиком (не только метаданные о факте
  // передачи), так что text/file_path/файл на диске остаются нетронутыми в
  // базе — удаление лишь прячет сообщение из интерфейса (routes/messages.js
  // отдаёт клиенту пустые text/file_path, когда deleted=1). Физически строка
  // и файл не трогаются вообще ни при каких обстоятельствах.
  // forEveryone решает область: без него сообщение прячется только у того, кто
  // удаляет (message_hidden), с ним — исчезает у всех (deleted=1). Своё можно
  // убрать у всех всегда; чужое — в личной переписке любому её участнику (там
  // собеседник ровно один, и это симметрично), а в группе только владельцу
  // группы и орг-администрации: иначе любой из полусотни участников мог бы
  // стереть чужую реплику у всех разом.
  socket.on('message_delete', (data) => {
    try {
      const { id, forEveryone } = data && typeof data === 'object' ? data : {};
      const userId = Number(socket.userId);
      if (!userId) return;

      const row = db.prepare('SELECT id, chat_id, sender_id, deleted, thread_root_id FROM messages WHERE id = ?').get(id);
      if (!row || row.deleted) return;
      if (!isParticipant(row.chat_id, userId)) return;

      if (!forEveryone) {
        if (!row.thread_root_id) {
          hideThread(row.id, userId);
          io.to('user:' + userId).emit('thread_hidden', { root_id: row.id, chat_id: row.chat_id });
        }
        db.prepare('INSERT OR IGNORE INTO message_hidden (message_id, user_id, hidden_at) VALUES (?, ?, ?)')
          .run(row.id, userId, Date.now());
        // Только этому человеку и только в его сессии — остальных это не касается.
        io.to('user:' + userId).emit('message_hidden', { id: row.id, chat_id: row.chat_id });
        return;
      }

      if (!canDeleteForEveryone(row, userId)) {
        socket.emit('message_delete_denied', { id: row.id, chat_id: row.chat_id });
        return;
      }

      if (!row.thread_root_id) {
        softDeleteThread(row.id, userId);
        emitToChat(row.chat_id, 'message_deleted', {
          id, chat_id: row.chat_id, thread_deleted: true,
        }, row.sender_id);
      } else {
        db.prepare('UPDATE messages SET deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?')
          .run(Date.now(), userId, id);
        emitToChat(row.chat_id, 'thread_message_deleted', {
          id, root_id: Number(row.thread_root_id), chat_id: row.chat_id,
        }, row.sender_id);
        emitToChat(row.chat_id, 'thread_summary_changed', {
          root_id: Number(row.thread_root_id),
        }, row.sender_id);
      }
    } catch (e) {
      console.error('Ошибка удаления сообщения:', e);
    }
  });

  // Поставить/сменить свою реакцию. Замена прежней — на уровне схемы
  // (PRIMARY KEY на паре message+user), отдельной проверки «уже ставил» не
}

module.exports = { register };
