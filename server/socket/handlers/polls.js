// Опросы: голос, свой вариант, досрочное завершение.
//
// Обработчики регистрируются на каждое подключение. Всё, что зависит от
// самого сервера (io, рассылка по комнатам), приходит контекстом: модуль
// не должен знать, как поднимается приложение.
const { addPollOption, stopPoll, voteInPoll } = require('../../services/polls');

function register(socket, ctx) {
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
}

module.exports = { register };
