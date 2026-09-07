// Индикатор набора текста.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.

function register(socket, ctx) {
  const { broadcastToChat } = ctx;

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
}

module.exports = { register };
