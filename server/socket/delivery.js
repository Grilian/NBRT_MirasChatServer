const db = require('../db');
const { isParticipant } = require('../services/chatParticipants');

// Пока человека не было в сети, входящие сообщения оставались в статусе 'sent'
// (доставлять было некому). Раньше в 'delivered' их переводил только клиент —
// событием 'message_delivered' из обработчика показа веб-уведомления, то есть
// если уведомления запрещены/не показались, статус не менялся вообще никогда.
// Теперь факт доставки фиксирует сервер, как только клиент появился на связи.
function markPendingDelivered(userId, emitToChat) {
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


module.exports = { markPendingDelivered };
