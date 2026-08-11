require('dotenv').config({ quiet: true });
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const verifyToken = require('./middleware/verifyToken');
const userRoutes = require('./routes/users');
const unreadRoutes = require('./routes/unread');
const favoritesRoutes = require('./routes/favorites');
const commentsRoutes = require('./routes/comments');
const superadminRoutes = require('./routes/superadmin');
const contactsRoutes = require('./routes/contacts');
const moderationRoutes = require('./routes/moderation');
const devicesRoutes = require('./routes/devices');
const updatesRoutes = require('./routes/updates');
const calendarRoutes = require('./routes/calendar');
const sessionRoutes = require('./routes/session');
const departmentsRoutes = require('./routes/departments');
const groupsRoutes = require('./routes/groups');
const tasksRoutes = require('./routes/tasks');
const emojiRoutes = require('./routes/emoji');
const notificationSettingsRoutes = require('./routes/notificationSettings');
const requireAdminRole = require('./middleware/requireAdminRole');
const { participantsForChatId, isParticipant } = require('./services/chatParticipants');
const { isSharedChat, markRead, readCountsFor } = require('./services/readReceipts');
const { isValidEmoji, reactionsFor, setReaction, removeReaction } = require('./services/reactions');
const { notifyNewMessage } = require('./services/push');
const { canPostToGroup } = require('./services/chatPermissions');
const { isValidChatImagePath } = require('./routes/messages');
const { canPostAnnouncement } = require('./routes/groups');
const {
  NotificationPolicyError,
  resolveForceNotification,
  shouldNotifyUser,
} = require('./services/notificationPolicy');
const calendarScheduler = require('./services/calendarScheduler');
const {
  PollError,
  normalizePollDraft,
  insertPoll,
  serializePoll,
  voteInPoll,
  addPollOption,
  stopPoll,
  emitPollUpdate,
  closeExpiredPolls,
} = require('./services/polls');
const { listRecentChats } = require('./services/recentChats');
const {
  ThreadError,
  rootForUser,
  hideThread,
  softDeleteThread,
} = require('./services/threads');

const db = require('./db');

// Группы, кому можно писать даже в режиме тишины — обращение к администрации
// напрямую, а не рассылка (general всё равно остаётся заблокирован).
const MUTE_EXEMPT_GROUPS = ['Администрация', 'Админы'];

const MAX_MESSAGE_LENGTH = 4000;
const MAX_READ_BATCH = 500;

// engine.io не разбирает X-Forwarded-For сам (socket.handshake.address —
// это адрес nginx на локалхосте, а не клиента) — достаём реальный IP из
// заголовка, который nginx уже прокидывает (см. proxy_set_header
// X-Forwarded-For в конфиге). Он нужен только как метаданные о факте
// передачи сообщения, в интерфейс не попадает.
// Канал-объявление: в нём у каждого сообщения показывается «просмотрено» с
// числом прочитавших, и это число должно расти живьём, а не только после
// перезагрузки истории (её отдаёт routes/messages.js).
function isAnnouncementChat(chatId) {
  const match = String(chatId).match(/^group_(\d+)$/);
  if (!match) return false;
  const group = db.prepare('SELECT announcements_only FROM chat_groups WHERE id = ?').get(Number(match[1]));
  return !!(group && group.announcements_only);
}

// Довесок к message_status_bulk — только для каналов-объявлений, в обычной
// переписке счётчик не показывается и считать его незачем.
function readCountsPayload(chatId, ids) {
  return isAnnouncementChat(chatId) ? { readCounts: readCountsFor(ids) } : {};
}

// Цитата исходного сообщения для ответа — та же форма, что отдаёт история
// (см. routes/messages.js). Удалённое цитируем пустым текстом: строка в базе
// остаётся навсегда, но её содержимое наружу не отдаётся ни при каких
// обстоятельствах, включая цитаты.
function replyPreviewOf(replyToId) {
  const row = db.prepare(`
    SELECT m.text, m.file_path, m.deleted, u.username, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(replyToId);
  if (!row) return {};
  return {
    reply_to_text: row.deleted ? '' : row.text,
    reply_to_file: row.deleted ? null : row.file_path,
    reply_to_author: row.display_name || row.username,
    reply_to_deleted: row.deleted ? 1 : 0,
  };
}

// Кто может убрать сообщение у ВСЕХ. Своё — всегда. Чужое: в личной переписке
// любой из двоих (собеседник ровно один, право симметрично), в общем чате и
// группах — владелец группы либо орг-администрация. Обычному участнику группы
// чужое доступно только «скрыть у себя»: иначе один человек мог бы вычистить
// переписку у полусотни людей, и восстановить её смог бы только админ
// запросом к базе (содержимое-то остаётся, но из интерфейса пропадает).
function canDeleteForEveryone(message, userId) {
  if (Number(message.sender_id) === Number(userId)) return true;

  const groupMatch = String(message.chat_id).match(/^group_(\d+)$/);
  if (groupMatch) {
    const membership = db.prepare(
      'SELECT role FROM chat_group_members WHERE chat_group_id = ? AND user_id = ?'
    ).get(Number(groupMatch[1]), userId);
    if (membership && membership.role === 'owner') return true;
    return canPostAnnouncement(userId); // admin/moderator по users.role
  }

  if (message.chat_id === 'general') return canPostAnnouncement(userId);

  // Личная переписка: участие уже проверено вызывающим кодом.
  return true;
}

function clientIpOf(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || null;
}

// Простейшая защита от флуда: не больше FLOOD_MAX_MESSAGES сообщений за
// FLOOD_WINDOW_MS с одного сокета. Без неё зациклившийся клиент (или кто-то
// вручную) мог за секунды забить БД и завалить уведомлениями всех участников.
const FLOOD_WINDOW_MS = 10000;
const FLOOD_MAX_MESSAGES = 20;

function isFlooding(socket) {
  const now = Date.now();
  const recent = (socket.recentMessageTimes || []).filter((t) => now - t < FLOOD_WINDOW_MS);
  recent.push(now);
  socket.recentMessageTimes = recent;
  return recent.length > FLOOD_MAX_MESSAGES;
}

const app = express();
app.use(cors());
app.use(express.json());

// REST API
app.use('/api/auth', authRoutes);
app.use('/api/messages', verifyToken, messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/unread', unreadRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/moderation', verifyToken, requireAdminRole, moderationRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/updates', updatesRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/departments', departmentsRoutes);
app.use('/api/groups', verifyToken, groupsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/emoji', emojiRoutes);
app.use('/api/notification-settings', notificationSettingsRoutes);

// Раздача загруженных аватаров — просто статика, без отдельной авторизации
// на каждый файл (как публичные CDN-ссылки на фото профиля у большинства
// мессенджеров), доступ к самому приложению уже закрыт логином/паролем.
// Смонтировано под /api/uploads (а не просто /uploads): в проде reverse-proxy
// проксирует на бэкенд только префикс /api — отдельного правила для /uploads
// нет, и файлы отдавались бы SPA-фолбэком (index.html) вместо самой картинки.
// Кэш навсегда: по умолчанию express.static шлёт `max-age=0`, и браузер
// перепроверяет КАЖДЫЙ файл при каждом открытии — пусть ответом и будет 304,
// но на слабой связи это лишний круговой обход на каждый смайлик, аватар и
// картинку. Именно это делало открытие группы заметно медленнее личного чата:
// в группе под каждым сообщением аватар, и таких перепроверок десятки.
//
// immutable здесь не допущение, а свойство схемы имён: содержимое по одному и
// тому же пути не меняется НИКОГДА. Аватар — `user_<id>_<время>.jpg` (новая
// загрузка = новое имя, старый файл удаляется), картинка сообщения —
// `msg_<id>_<время>_<случайное>.webp`, смайлик — `emoji_<имя>_<случайное>.webp`
// (замена картинки под тем же кодом пишет НОВЫЙ файл и удаляет прежний).
// Заводя загрузку с предсказуемым именем, это правило придётся пересмотреть.
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '365d',
  immutable: true,
}));

const server = http.createServer(app);
const io = new Server(server, {
  path: process.env.SOCKET_IO_PATH || '/MirasChatServer/socket.io',
  cors: {
    origin: '*'
  }
});

// Нужен маршрутам панели супер-админа, чтобы толкать живые обновления
// (например, режим тишины) в комнату конкретного пользователя — не бродкаст
// пользовательских данных всем подряд, а адресный пуш от доверенного
// серверного действия, поэтому это не повторяет ранее убранную уязвимость.
app.set('io', io);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// extraUserId — отправитель добавляется в комнату явно, иначе не получал бы
// эхо собственного сообщения/правки/удаления.
function emitToChat(chatId, event, payload, extraUserId) {
  const participants = participantsForChatId(chatId);
  if (participants === null) {
    io.emit(event, payload);
    return;
  }
  const rooms = new Set(participants.map((id) => 'user:' + id));
  if (extraUserId !== undefined && extraUserId !== null) rooms.add('user:' + extraUserId);
  if (rooms.size) io.to([...rooms]).emit(event, payload);
}

function broadcastToChat(socket, chatId, event, payload) {
  const participants = participantsForChatId(chatId);
  if (participants === null) {
    socket.broadcast.emit(event, payload);
  } else if (participants.length) {
    socket.to(participants.map((id) => 'user:' + id)).emit(event, payload);
  }
}

// ===== WebSocket =====
// userId -> Set<socketId>. Раньше здесь был Map userId -> socketId, и это
// ломалось при нескольких сессиях одного человека (вторая вкладка, телефон
// плюс десктоп, а также momentary-переподключение, когда новый сокет успевает
// подняться раньше, чем отвалится старый): вход со второго устройства затирал
// запись первого, а его 'disconnect' затем помечал пользователя оффлайн,
// хотя он оставался на связи. Отсюда мигающий индикатор "в сети" и, что
// важнее, recipientOnline === false — сообщение не помечалось доставленным.
const onlineSockets = new Map();

function markSocketOnline(userId, socketId) {
  const existing = onlineSockets.get(userId);
  if (existing) existing.add(socketId);
  else onlineSockets.set(userId, new Set([socketId]));
}

// Возвращает true, если это была последняя живая сессия пользователя, то есть
// он действительно ушёл в оффлайн (а не просто закрыл одну из вкладок).
function markSocketOffline(userId, socketId) {
  const sockets = onlineSockets.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size > 0) return false;
  onlineSockets.delete(userId);
  return true;
}

const onlineUserIds = () => Array.from(onlineSockets.keys());
const isUserOnline = (userId) => onlineSockets.has(Number(userId));

// Сокеты приложений, ушедших в фон (Android свернули кнопкой «Домой»).
//
// Живой сокет сам по себе НЕ значит, что человеку есть чем показать
// уведомление: свёрнутый на Android WebView замораживает таймеры и JS, и
// клиент физически не обработает пришедшее сообщение — а сокет при этом
// висит подключённым ещё десятки секунд (пока не отвалится по pingTimeout),
// и всё это время сервер считал получателя онлайн и пуш не слал. В итоге
// уведомление не показывал никто: ни клиент (заморожен), ни сервер (думал,
// что клиент сам справится). Приложение само сообщает о переходе в фон
// событием 'app_state', и для решения «слать ли пуш» верить надо ему.
const backgroundedSockets = new Set();

/** Есть ли у человека сокет, который прямо сейчас способен показать уведомление сам. */
function canReceiveInApp(userId) {
  const sockets = onlineSockets.get(Number(userId));
  if (!sockets) return false;
  for (const socketId of sockets) {
    if (!backgroundedSockets.has(socketId)) return true;
  }
  return false;
}

// Пока человека не было в сети, входящие сообщения оставались в статусе 'sent'
// (доставлять было некому). Раньше в 'delivered' их переводил только клиент —
// событием 'message_delivered' из обработчика показа веб-уведомления, то есть
// если уведомления запрещены/не показались, статус не менялся вообще никогда.
// Теперь факт доставки фиксирует сервер, как только клиент появился на связи.
function markPendingDelivered(userId) {
  try {
    const pending = db.prepare(
      "SELECT id, chat_id FROM messages WHERE sender_id != ? AND status = 'sent'"
    ).all(userId);

    const byChat = {};
    for (const row of pending) {
      if (!isParticipant(row.chat_id, userId)) continue;
      (byChat[row.chat_id] = byChat[row.chat_id] || []).push(row.id);
    }

    const allIds = Object.values(byChat).flat();
    if (!allIds.length) return;

    const placeholders = allIds.map(() => '?').join(',');
    db.prepare(`UPDATE messages SET status = 'delivered' WHERE id IN (${placeholders})`).run(...allIds);

    for (const [chatId, messageIds] of Object.entries(byChat)) {
      emitToChat(chatId, 'message_status_bulk', { chatId, messageIds, status: 'delivered' });
    }
  } catch (e) {
    console.error('Ошибка отметки доставленных:', e);
  }
}

io.on('connection', (socket) => {
  console.log(`Подключен: ${socket.id}`);

  // Раньше принимали userId прямо от клиента без проверки — любой мог
  // назваться чужим id и получать чужие личные сообщения через комнату
  // 'user:<id>'. Теперь клиент присылает свой JWT, а userId берём из него.
  socket.on('user_online', (token, ack) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_super_secret_key');
      const userId = decoded.id;
      markSocketOnline(userId, socket.id);
      socket.userId = userId;
      socket.join('user:' + userId);
      io.emit('online_users', onlineUserIds());
      markPendingDelivered(userId);
      if (typeof ack === 'function') ack({ ok: true, userId });
    } catch (e) {
      socket.emit('auth_error', { reason: 'invalid_token' });
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_token' });
    }
  });

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
    // Обрезка не должна разрубить код кастомного смайлика: огрызок ":cat" уже
    // не станет картинкой и остался бы в БД навсегда техническим текстом.
    // Клиент режет текст сам, но его обрезку можно обойти — это последняя линия.
    const finalText = pollDraft
      ? pollDraft.question
      : (text.length > MAX_MESSAGE_LENGTH
        ? text.slice(0, MAX_MESSAGE_LENGTH).replace(/:[a-z0-9_]{1,32}$/, '')
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

    // Сообщение без текста и без картинки — отправлять нечего.
    if (!finalText && !filePath) { respond({ ok: false, error: 'empty_message' }); return; }

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
           reply_to_id, forwarded_from_name, forwarded_from_chat, client_message_id, force_notification)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Сообщение и опрос — одна атомарная операция: нельзя оставить в ленте
      // текст вопроса без вариантов, если вставка опроса оборвалась.
      const persist = db.transaction(() => {
        const result = stmt.run(
          data.chatId, senderId, finalText, filePath, fileWidth, fileHeight, 'sent', clientIpOf(socket),
          finalReplyTo, forwardedFromName, forwardedFromChat, clientMessageId, forceNotification ? 1 : 0
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
        notifyNewMessage(userId, {
          chatId: data.chatId,
          messageId: result.lastInsertRowid,
          senderName,
          chatLabel,
          forceNotification,
        });
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
  // thread_root_id и канал выдачи: в основную ленту ответ не дублируется.
  socket.on('thread_message', (rawData, ack) => {
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    const respond = (payload) => { if (typeof ack === 'function') ack(payload); };
    const senderId = Number(socket.userId);
    if (!senderId) { respond({ ok: false, error: 'auth_required' }); return; }

    try {
      const root = rootForUser(data.rootId, senderId);
      const forceNotification = resolveForceNotification(senderId, data.forceNotification === true);
      if (isFlooding(socket)) { respond({ ok: false, error: 'rate_limit' }); return; }
      const groupMatch = String(root.chat_id).match(/^group_(\d+)$/);
      if (groupMatch && !canPostToGroup(Number(groupMatch[1]), senderId)) {
        respond({ ok: false, error: 'write_not_allowed' });
        return;
      }

      const sender = db.prepare(
        'SELECT username, display_name, avatar_path, muted FROM users WHERE id = ?'
      ).get(senderId);
      if (sender?.muted) {
        const participants = participantsForChatId(root.chat_id);
        let muteExempt = false;
        if (participants && participants.length === 2) {
          const otherId = participants.find((participantId) => participantId !== senderId);
          const otherGroup = db.prepare(
            'SELECT g.name FROM users u LEFT JOIN groups g ON g.id = u.group_id WHERE u.id = ?'
          ).get(otherId);
          muteExempt = !!(otherGroup && MUTE_EXEMPT_GROUPS.includes(otherGroup.name));
        }
        if (!muteExempt) { respond({ ok: false, error: 'muted' }); return; }
      }

      const clientMessageId = data.clientMessageId == null ? null : String(data.clientMessageId);
      if (clientMessageId && !/^[a-zA-Z0-9_-]{16,100}$/.test(clientMessageId)) {
        respond({ ok: false, error: 'invalid_client_message_id' });
        return;
      }
      if (clientMessageId) {
        const existing = db.prepare(
          'SELECT id, created_at FROM messages WHERE sender_id = ? AND client_message_id = ?'
        ).get(senderId, clientMessageId);
        if (existing) {
          respond({ ok: true, messageId: Number(existing.id), createdAt: existing.created_at, deduplicated: true });
          return;
        }
      }

      let pollDraft = null;
      if (data.poll != null) pollDraft = normalizePollDraft(data.poll);
      const rawText = typeof data.text === 'string' ? data.text.trim() : '';
      const text = pollDraft
        ? pollDraft.question
        : rawText.slice(0, MAX_MESSAGE_LENGTH).replace(/:[a-z0-9_]{1,32}$/, '');
      const hasImage = !pollDraft && typeof data.filePath === 'string' && isValidChatImagePath(data.filePath);
      const filePath = hasImage ? data.filePath : null;
      const fileWidth = hasImage && Number.isFinite(Number(data.fileWidth)) ? Number(data.fileWidth) : null;
      const fileHeight = hasImage && Number.isFinite(Number(data.fileHeight)) ? Number(data.fileHeight) : null;
      if (!text && !filePath) { respond({ ok: false, error: 'empty_message' }); return; }

      const requestedReply = Number(data.replyToId);
      const replySource = Number.isInteger(requestedReply) && requestedReply > 0
        ? db.prepare(`
            SELECT id FROM messages
            WHERE id = ? AND chat_id = ? AND (id = ? OR thread_root_id = ?)
          `).get(requestedReply, root.chat_id, root.id, root.id)
        : null;
      const replyToId = replySource ? requestedReply : null;
      const persist = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO messages
            (chat_id, sender_id, text, file_path, file_width, file_height, status,
             sender_ip, reply_to_id, client_message_id, thread_root_id, force_notification)
          VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)
        `).run(root.chat_id, senderId, text, filePath, fileWidth, fileHeight,
          clientIpOf(socket), replyToId, clientMessageId, root.id, forceNotification ? 1 : 0);
        const poll = pollDraft ? insertPoll(result.lastInsertRowid, root.chat_id, senderId, pollDraft) : null;
        return { result, pollId: poll ? poll.id : null };
      });
      const { result, pollId } = persist();
      const message = {
        id: Number(result.lastInsertRowid),
        chat_id: root.chat_id,
        thread_root_id: Number(root.id),
        sender_id: senderId,
        username: sender?.username,
        display_name: sender?.display_name,
        avatar_path: sender?.avatar_path,
        text,
        file_path: filePath,
        file_width: fileWidth,
        file_height: fileHeight,
        status: 'sent',
        created_at: new Date().toISOString(),
        force_notification: forceNotification,
        client_message_id: clientMessageId,
        reply_to_id: replyToId,
        ...(replyToId ? replyPreviewOf(replyToId) : {}),
        ...(pollId ? { poll: serializePoll(pollId, senderId) } : {}),
        reactions: [],
      };

      emitToChat(root.chat_id, 'thread_message', message, senderId);
      // Только сигнал «сводка ветки изменилась», без самой сводки: unread в ней
      // считается под конкретного зрителя, а событие одно на всех. Раньше сюда
      // клалась сводка отправителя (unread всегда 0) — по ней у остальных
      // непрочитанное обнулялось бы. Актуальную каждый клиент берёт сам через
      // /threads/:id/summary — как это и делается, см. onThreadSummary.
      emitToChat(root.chat_id, 'thread_summary_changed', { root_id: Number(root.id) }, senderId);
      respond({ ok: true, messageId: message.id, createdAt: message.created_at, pollId });

      // Уведомления ветки получают автор корня и уже участвовавшие в ней люди.
      // Сам ответ при этом виден всем участникам исходного чата; подписка
      // влияет только на отвлекающий сигнал, а не на доступ к данным.
      const subscribedIds = db.prepare(`
        SELECT DISTINCT sender_id FROM messages
        WHERE (id = ? OR thread_root_id = ?) AND sender_id != ?
      `).all(root.id, root.id, senderId)
        .map((row) => Number(row.sender_id))
        .filter((userId) => isParticipant(root.chat_id, userId))
        .filter((userId) => !db.prepare(
          'SELECT 1 FROM thread_hidden WHERE root_message_id = ? AND user_id = ?'
        ).get(root.id, userId));

      if (subscribedIds.length) {
        io.to(subscribedIds.map((userId) => `user:${userId}`)).emit('thread_notification', {
          ...message,
          root_id: Number(root.id),
        });
      }

      let chatLabel = 'Ветка';
      if (root.chat_id === 'general') chatLabel = 'Ветка · Общий чат';
      else if (groupMatch) {
        const group = db.prepare('SELECT name FROM chat_groups WHERE id = ?').get(Number(groupMatch[1]));
        if (group?.name) chatLabel = `Ветка · ${group.name}`;
      }
      const senderName = sender ? (sender.display_name || sender.username) : undefined;
      for (const userId of subscribedIds
        .filter((id) => !canReceiveInApp(id))
        .filter((id) => shouldNotifyUser(id, root.chat_id, forceNotification))) {
        notifyNewMessage(userId, {
          chatId: root.chat_id,
          messageId: message.id,
          senderName,
          chatLabel,
          forceNotification,
          requiredFeature: 'threads',
          threadRootId: Number(root.id),
        });
      }

      if (subscribedIds.some((userId) => isUserOnline(userId))) {
        db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'").run(message.id);
        emitToChat(root.chat_id, 'message_status', { id: message.id, status: 'delivered' }, senderId);
      }
    } catch (error) {
      console.error('Ошибка отправки в ветку:', error);
      respond({
        ok: false,
        error: error instanceof ThreadError || error instanceof PollError || error instanceof NotificationPolicyError
          ? error.code
          : 'thread_message_failed',
      });
    }
  });

  const runPollAction = (data, action) => {
    const userId = socket.userId;
    if (!userId) return;
    if (isFlooding(socket)) {
      socket.emit('poll_error', { code: 'rate_limit', message: 'Слишком много действий подряд' });
      return;
    }
    try {
      const pollId = action(userId);
      emitPollUpdate(io, pollId);
    } catch (e) {
      socket.emit('poll_error', {
        poll_id: Number(data && data.pollId) || undefined,
        code: e instanceof PollError ? e.code : 'poll_action_failed',
        message: e.message || 'Не удалось обновить опрос',
      });
    }
  };

  socket.on('poll_vote', (data) => {
    runPollAction(data, (userId) => voteInPoll(data && data.pollId, userId, data && data.optionIds));
  });

  socket.on('poll_add_option', (data) => {
    runPollAction(data, (userId) => addPollOption(data && data.pollId, userId, data && data.text));
  });

  socket.on('poll_stop', (data) => {
    runPollAction(data, (userId) => stopPoll(data && data.pollId, userId));
  });

  // Приложение свернули/развернули. Шлёт только нативный мобильный клиент —
  // у него это событие жизненного цикла Capacitor, единственный надёжный
  // признак того, что показать уведомление своими силами он уже не сможет.
  socket.on('app_state', (data) => {
    const active = typeof data === 'boolean' ? data : !!(data && data.active);
    if (active) backgroundedSockets.delete(socket.id);
    else backgroundedSockets.add(socket.id);
  });

  socket.on('typing', (data) => {
    if (!data || typeof data !== 'object') return;
    broadcastToChat(socket, data.chatId, 'typing', {
      chatId: data.chatId,
      userId: data.userId,
      username: data.username
    });
  });

  socket.on('stop_typing', (data) => {
    if (!data || typeof data !== 'object') return;
    broadcastToChat(socket, data.chatId, 'stop_typing', {
      chatId: data.chatId,
      userId: data.userId
    });
  });

  // Раньше здесь не было вообще никаких проверок: клиент присылал любой набор
  // id, и сервер помечал их прочитанными — можно было погасить чужие счётчики
  // непрочитанного или, наоборот, отметить прочитанными собственные исходящие
  // сообщения (клиент их фильтрует, но полагаться на это нельзя). Теперь
  // сужаем апдейт до чата, в котором сокет реально участник, и только до
  // чужих сообщений в нём.
  socket.on('message_read', (data) => {
    const { chatId, messageIds } = data && typeof data === 'object' ? data : {};
    const userId = socket.userId;
    if (!userId || !chatId) return;
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    if (!isParticipant(chatId, userId)) return;

    try {
      const ids = messageIds.map(Number).filter(Number.isInteger).slice(0, MAX_READ_BATCH);
      if (!ids.length) return;

      const affected = markRead(userId, chatId, ids);
      if (!affected.length) return;

      emitToChat(chatId, 'message_status_bulk', {
        chatId, messageIds: affected, status: 'read', ...readCountsPayload(chatId, affected),
      }, userId);
    } catch (e) {
      console.error('Ошибка отметки прочитанного:', e);
    }
  });

  socket.on('message_delivered', (messageId) => {
    const userId = socket.userId;
    if (!userId) return;

    try {
      const row = db.prepare('SELECT chat_id, sender_id, status FROM messages WHERE id = ?').get(messageId);
      // Доставленным сообщение может объявить только его получатель — не
      // отправитель и не посторонний, знающий id.
      if (!row || row.status !== 'sent') return;
      if (Number(row.sender_id) === Number(userId)) return;
      if (!isParticipant(row.chat_id, userId)) return;

      db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'").run(messageId);
      emitToChat(row.chat_id, 'message_status', { id: messageId, status: 'delivered' });
    } catch (e) {
      console.error('Ошибка обновления статуса:', e);
    }
  });

  // Разовая ручная "починка" застрявших счётчиков непрочитанного — например,
  // если бейдж повис из-за прежнего бага с широковещательной рассылкой личных
  // сообщений (см. приватность-фикс) или клиент просто не успел отметить
  // прочитанным вовремя. Помечаем читанными только те чаты, где сокет
  // реально участник — та же проверка, что и в emitToChat.
  socket.on('mark_all_read', () => {
    const userId = socket.userId;
    if (!userId) return;

    try {
      // Личные чаты: кандидаты по общему status, как и раньше — там он
      // однозначен. Общие/групповые: кандидатами могут быть сообщения,
      // у которых status уже 'read' (его выставил кто-то другой), поэтому их
      // ищем отдельно — по отсутствию личной отметки в message_reads.
      const personalCandidates = db.prepare(
        "SELECT id, chat_id FROM messages WHERE sender_id != ? AND status != 'read'"
      ).all(userId).filter((row) => !isSharedChat(row.chat_id));

      const sharedCandidates = db.prepare(`
        SELECT m.id, m.chat_id FROM messages m
        LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
        WHERE m.sender_id != ? AND r.message_id IS NULL
          AND (m.chat_id = 'general' OR m.chat_id LIKE 'group\\_%' ESCAPE '\\')
      `).all(userId, userId);

      const byChat = {};
      for (const row of [...personalCandidates, ...sharedCandidates]) {
        const participants = participantsForChatId(row.chat_id);
        const isParticipant = participants === null || participants.includes(Number(userId));
        if (isParticipant) {
          (byChat[row.chat_id] = byChat[row.chat_id] || []).push(row.id);
        }
      }

      for (const [chatId, ids] of Object.entries(byChat)) {
        const affected = markRead(userId, chatId, ids);
        if (affected.length) {
          emitToChat(chatId, 'message_status_bulk', {
            chatId, messageIds: affected, status: 'read', ...readCountsPayload(chatId, affected),
          });
        }
      }
    } catch (e) {
      console.error('Ошибка при массовой отметке прочитанного:', e);
    }
  });

  // Редактировать/удалить можно только своё сообщение — проверяем по
  // фактическому sender_id в БД, а не по тому, что прислал клиент (в отличие
  // от chat_message/senderId, здесь это разрушающее действие над чужими данными).
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
  // нужно. Повторный клик по той же реакции снимает её — как в Telegram.
  socket.on('reaction_set', (data) => {
    try {
      const { messageId, emoji } = data && typeof data === 'object' ? data : {};
      const userId = Number(socket.userId);
      if (!userId || !isValidEmoji(emoji)) return;

      const row = db.prepare('SELECT id, chat_id, deleted FROM messages WHERE id = ?').get(messageId);
      if (!row || row.deleted) return;
      if (!isParticipant(row.chat_id, userId)) return;

      const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?')
        .get(row.id, userId);

      if (existing && existing.emoji === emoji) removeReaction(row.id, userId);
      else setReaction(row.id, userId, emoji);

      emitToChat(row.chat_id, 'reactions_changed', {
        chat_id: row.chat_id, message_id: row.id, reactions: reactionsFor(row.id),
      }, userId);
    } catch (e) {
      console.error('Ошибка установки реакции:', e);
    }
  });

  // Снять реакцию. Свою — всегда; чужую — только автор сообщения и только под
  // своим: это про «уберите это из-под моей реплики», а не про модерацию чужих
  // реакций где угодно.
  socket.on('reaction_remove', (data) => {
    try {
      const { messageId, userId: targetUserId } = data && typeof data === 'object' ? data : {};
      const userId = Number(socket.userId);
      if (!userId) return;

      const row = db.prepare('SELECT id, chat_id, sender_id, deleted FROM messages WHERE id = ?').get(messageId);
      if (!row || row.deleted) return;
      if (!isParticipant(row.chat_id, userId)) return;

      const target = Number(targetUserId) || userId;
      if (target !== userId && Number(row.sender_id) !== userId) return;

      removeReaction(row.id, target);
      emitToChat(row.chat_id, 'reactions_changed', {
        chat_id: row.chat_id, message_id: row.id, reactions: reactionsFor(row.id),
      }, userId);
    } catch (e) {
      console.error('Ошибка снятия реакции:', e);
    }
  });

  socket.on('disconnect', () => {
    backgroundedSockets.delete(socket.id);
    // Оффлайн объявляем, только когда отвалилась последняя сессия человека —
    // иначе закрытая вкладка гасила индикатор "в сети" у ещё живого клиента.
    if (socket.userId && markSocketOffline(socket.userId, socket.id)) {
      io.emit('online_users', onlineUserIds());
    }
    console.log(`Отключен: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  // Планировщик после старта: он ходит в базу и рассылает через io, а оба
  // должны быть готовы. Состояния в памяти он не держит, так что перезапуск
  // сервера ничего не теряет.
  calendarScheduler.start(io);
  // Дедлайн должен завершать опрос сам, даже если в этот момент никто не
  // открыл сообщение и не попытался проголосовать. Обновление рассылается
  // персонально, чтобы анонимный опрос не раскрыл список участников.
  const sweepPollDeadlines = () => {
    try { closeExpiredPolls(io); }
    catch (error) { console.error('Ошибка завершения опросов по сроку:', error); }
  };
  sweepPollDeadlines();
  const pollDeadlineTimer = setInterval(sweepPollDeadlines, 30_000);
  pollDeadlineTimer.unref?.();
});
