const { createRooms } = require('./rooms');
const { markPendingDelivered } = require('./delivery');

const handlers = [
  require('./handlers/presence'),
  require('./handlers/messages'),
  require('./handlers/threads'),
  require('./handlers/reads'),
  require('./handlers/reactions'),
  require('./handlers/polls'),
  require('./handlers/typing'),
];

/**
 * Подключить слой сокета к серверу.
 *
 * Обработчики разложены по доменам и ничего не знают друг о друге: общее у них
 * только то, что приходит контекстом — сам io, адресная рассылка по участникам
 * чата и отметка доставленным.
 */
function attachSocketLayer(io) {
  const { emitToChat, broadcastToChat } = createRooms(io);
  const ctx = {
    io,
    emitToChat,
    broadcastToChat,
    markPendingDelivered: (userId) => markPendingDelivered(userId, emitToChat),
  };

  io.on('connection', (socket) => {
    console.log(`Подключен: ${socket.id}`);
    for (const handler of handlers) handler.register(socket, ctx);
  });

  return ctx;
}

module.exports = { attachSocketLayer };
