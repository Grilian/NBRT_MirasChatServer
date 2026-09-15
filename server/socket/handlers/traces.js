// Следы под сообщением — «Наследить» и «Снять след».
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от самого
// сервера (io, рассылка по комнатам), приходит контекстом.
const db = require('../../db');
const { isParticipant } = require('../../services/chatParticipants');
const { hasTrace, removeTrace, resolveOrigin, setTrace, traceCount } = require('../../services/traces');

function register(socket, ctx) {
  const { emitToChat } = ctx;

  // Счётчик живёт на ПЕРВОИСТОЧНИКЕ, поэтому и событие уходит в комнату его
  // чата, а не того, где нажали. Наследить может человек, которого в чате
  // origin нет вовсе — он получил след передачей; лапка при этом вырастет у
  // участников исходного чата, и это осознанная утечка метаданных (traces.md).
  const broadcast = (origin, actorId) => {
    emitToChat(origin.chat_id, 'traces_changed', {
      chat_id: origin.chat_id,
      message_id: origin.id,
      trace_count: traceCount(origin.id),
    }, actorId);
  };

  socket.on('trace_set', (data) => {
    try {
      const { messageId, note } = data && typeof data === 'object' ? data : {};
      const userId = Number(socket.userId);
      if (!userId) return;

      const row = db.prepare('SELECT id, chat_id, deleted FROM messages WHERE id = ?').get(messageId);
      if (!row || row.deleted) return;
      // Право проверяется по тому чату, где человек НАЖАЛ: именно его он и
      // видит. Доступ к чату первоисточника проверяется отдельно и позже — в
      // момент перехода к нему, а не при сохранении следа.
      if (!isParticipant(row.chat_id, userId)) return;

      const origin = resolveOrigin(row.id);
      if (!origin) return;

      setTrace(origin.id, origin.chat_id, userId, note);
      broadcast(origin, userId);
      socket.emit('trace_result', { message_id: row.id, origin_message_id: origin.id, traced: true });
    } catch (e) {
      console.error('Ошибка сохранения следа:', e);
    }
  });

  socket.on('trace_remove', (data) => {
    try {
      const { messageId } = data && typeof data === 'object' ? data : {};
      const userId = Number(socket.userId);
      if (!userId) return;

      // Удалённое сообщение снять со следов МОЖНО, в отличие от постановки:
      // подчищенный след — законное состояние, и человек вправе убрать его из
      // своего списка. Поэтому здесь нет проверки на deleted.
      const row = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(messageId);
      if (!row) return;

      const origin = resolveOrigin(row.id);
      if (!origin || !hasTrace(origin.id, userId)) return;

      removeTrace(origin.id, userId);
      broadcast(origin, userId);
      socket.emit('trace_result', { message_id: row.id, origin_message_id: origin.id, traced: false });
    } catch (e) {
      console.error('Ошибка снятия следа:', e);
    }
  });
}

module.exports = { register };
