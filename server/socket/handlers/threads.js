// Ветки: ответ в ветке.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.
const db = require('../../db');
const { isParticipant, participantsForChatId } = require('../../services/chatParticipants');
const { canPostToGroup } = require('../../services/chatPermissions');
const { isValidChatFilePath, isValidChatImagePath } = require('../../routes/messages');
const { NotificationPolicyError, resolveForceNotification, shouldNotifyUser } = require('../../services/notificationPolicy');
const { PollError, emitPollUpdate, insertPoll, normalizePollDraft, serializePoll } = require('../../services/polls');
const { trimDanglingShortcode } = require('../../utils/shortcode');
const { ThreadError, rootForUser } = require('../../services/threads');
const { MAX_MESSAGE_LENGTH, MUTE_EXEMPT_GROUPS, clientIpOf, isFlooding, replyPreviewOf } = require('../chatHelpers');
const { canReceiveInApp, isUserOnline, schedulePush } = require('../presence');

function register(socket, ctx) {
  const { io, emitToChat } = ctx;

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
      // См. основной обработчик chat_message: стикер исключает подпись, так
      // что случайно прицепленный текст не оседает рядом с ним в БД.
      const stickerRequested = Number.isInteger(Number(data.stickerId));
      const text = pollDraft
        ? pollDraft.question
        : stickerRequested
          ? ''
          : trimDanglingShortcode(rawText.slice(0, MAX_MESSAGE_LENGTH));
      const hasImage = !pollDraft && typeof data.filePath === 'string' && isValidChatImagePath(data.filePath);
      const filePath = hasImage ? data.filePath : null;
      const fileWidth = hasImage && Number.isFinite(Number(data.fileWidth)) ? Number(data.fileWidth) : null;
      const fileHeight = hasImage && Number.isFinite(Number(data.fileHeight)) ? Number(data.fileHeight) : null;
      const hasSticker = !pollDraft && !hasImage && stickerRequested;
      const stickerRow = hasSticker
        ? db.prepare('SELECT id, emoji FROM sticker_items WHERE id = ?').get(Number(data.stickerId))
        : null;
      const stickerId = stickerRow ? stickerRow.id : null;
      const stickerFallback = stickerRow ? stickerRow.emoji : null;
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
      if (!text && !filePath && !stickerId && !documentPath) {
        respond({ ok: false, error: 'empty_message' });
        return;
      }

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
             sender_ip, reply_to_id, client_message_id, thread_root_id, force_notification,
             sticker_id, sticker_fallback, document_path, document_name, document_size, document_mime)
          VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(root.chat_id, senderId, text, filePath, fileWidth, fileHeight,
          clientIpOf(socket), replyToId, clientMessageId, root.id, forceNotification ? 1 : 0,
          stickerId, stickerFallback, documentPath, documentName, documentSize, documentMime);
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
        sticker_id: stickerId,
        sticker_fallback: stickerFallback,
        document_path: documentPath,
        document_name: documentName,
        document_size: documentSize,
        document_mime: documentMime,
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
        schedulePush(userId, {
          chatId: root.chat_id,
          messageId: message.id,
          senderName,
          chatLabel,
          forceNotification,
          threadRootId: Number(root.id),
        }, { defer: isUserOnline(userId) });
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
}

module.exports = { register };
