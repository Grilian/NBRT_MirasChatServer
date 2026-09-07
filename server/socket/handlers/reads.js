// Прочтение и доставка.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.
const db = require('../../db');
const { isParticipant, participantsForChatId } = require('../../services/chatParticipants');
const { isSharedChat, markRead } = require('../../services/readReceipts');
const { MAX_READ_BATCH, readCountsPayload } = require('../chatHelpers');

function register(socket, ctx) {
  const { emitToChat } = ctx;

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
  // Пометить прочитанным ОДИН чат — пункт контекстного меню в списке чатов.
  //
  // Отдельно от mark_all_read: тот проходит по всей переписке человека, а здесь
  // нужен ровно один чат, и гонять полный проход ради него незачем. Правила
  // отметки те же самые (личные — по status, общие и группы — по message_reads),
  // поэтому и отметка идёт через общий markRead.
  socket.on('mark_chat_read', (data) => {
    const userId = socket.userId;
    const chatId = data && typeof data === 'object' ? String(data.chatId || '') : '';
    if (!userId || !chatId) return;

    try {
      if (!isParticipant(chatId, userId)) return;

      const ids = isSharedChat(chatId)
        ? db.prepare(`
            SELECT m.id FROM messages m
            LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
            WHERE m.chat_id = ? AND m.sender_id != ? AND r.message_id IS NULL
          `).all(userId, chatId, userId).map((row) => row.id)
        : db.prepare(
          "SELECT id FROM messages WHERE chat_id = ? AND sender_id != ? AND status != 'read'"
        ).all(chatId, userId).map((row) => row.id);

      if (!ids.length) return;
      const affected = markRead(userId, chatId, ids);
      if (affected.length) {
        emitToChat(chatId, 'message_status_bulk', {
          chatId, messageIds: affected, status: 'read', ...readCountsPayload(chatId, affected),
        });
      }
    } catch (e) {
      console.error('Ошибка отметки чата прочитанным:', e);
    }
  });

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
}

module.exports = { register };
