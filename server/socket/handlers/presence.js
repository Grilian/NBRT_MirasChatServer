// Присутствие: вход в сокет, фон, отключение.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.
const { cancelPendingPush, forgetSocket, markSocketOffline, markSocketOnline, onlineUserIds, schedulePush, setBackgrounded } = require('../presence');
const jwt = require('jsonwebtoken');
const { epochValid } = require('../../services/tokenEpoch');

function register(socket, ctx) {
  const { io, markPendingDelivered } = ctx;

  socket.on('user_online', (token, ack) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_super_secret_key');
      // Отозванный токен обязан отваливаться и здесь: иначе устройство,
      // выгнанное сменой пароля, теряет только HTTP, а сокет продолжает
      // приносить ему чужую переписку.
      if ((decoded.source || 'local') === 'local' && !epochValid(decoded)) {
        throw new Error('token revoked');
      }
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

  socket.on('app_state', (data) => {
    const active = typeof data === 'boolean' ? data : !!(data && data.active);
    setBackgrounded(socket.id, !active);
  });

  // Свёрнутый клиент успел показать уведомление сам — снимаем отложенный пуш,
  // иначе в шторке окажутся две карточки об одном сообщении (см. schedulePush).
  socket.on('message_notified', (data) => {
    const messageId = Number(data && data.messageId);
    if (!socket.userId || !Number.isInteger(messageId)) return;
    cancelPendingPush(socket.userId, messageId);
  });

  socket.on('disconnect', () => {
    forgetSocket(socket.id);
    // Оффлайн объявляем, только когда отвалилась последняя сессия человека —
    // иначе закрытая вкладка гасила индикатор "в сети" у ещё живого клиента.
    if (socket.userId && markSocketOffline(socket.userId, socket.id)) {
      io.emit('online_users', onlineUserIds());
    }
    console.log(`Отключен: ${socket.id}`);
  });
}

module.exports = { register };
