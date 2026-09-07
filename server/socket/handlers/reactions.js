// Реакции под сообщением.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.
const db = require('../../db');
const { isParticipant } = require('../../services/chatParticipants');
const { isValidEmoji, reactionsFor, removeReaction, setReaction } = require('../../services/reactions');

function register(socket, ctx) {
  const { emitToChat } = ctx;

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
}

module.exports = { register };
