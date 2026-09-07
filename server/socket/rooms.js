const { participantsForChatId } = require('../services/chatParticipants');

// Рассылка по участникам чата. `participantsForChatId` возвращает null для
// общего чата — там получатели это все, и адресовать некому.
//
// Фабрика, а не модуль с готовыми функциями: io создаётся в точке входа, и
// тянуть его отсюда обратным импортом значило бы завести кольцо.
function createRooms(io) {
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

  return { emitToChat, broadcastToChat };
}

module.exports = { createRooms };
