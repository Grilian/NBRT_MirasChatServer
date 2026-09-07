require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');

const app = require('./app');
const { attachSocketLayer } = require('./socket');
const calendarScheduler = require('./services/calendarScheduler');
const googleCalendarSync = require('./services/googleCalendarSync');
const { closeExpiredPolls } = require('./services/polls');

const server = http.createServer(app);
const io = new Server(server, {
  path: process.env.SOCKET_IO_PATH || '/MirasChatServer/socket.io',
  cors: {
    origin: '*'
  }
});

// Нужен маршрутам панели супер-админа, чтобы толкать живые обновления
// (например, режим тишины) в комнату конкретного пользователя — не бродкаст
// пользовательских данных всем подряд, а адресный пуш от доверенного
// серверного действия.
app.set('io', io);

attachSocketLayer(io);

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  // Планировщик после старта: он ходит в базу и рассылает через io, а оба
  // должны быть готовы. Состояния в памяти он не держит, так что перезапуск
  // сервера ничего не теряет.
  calendarScheduler.start(io);
  // Синхронизация с Google — тоже после старта и по той же причине. Первый
  // проход отложен внутри: упираться в чужую сеть прямо на запуске незачем,
  // а если аккаунт не подключён, она просто ничего не делает.
  googleCalendarSync.start(io);
  // Дедлайн должен завершать опрос сам, даже если в этот момент никто не
  // открыл сообщение и не попытался проголосовать. Обновление рассылается
  // персонально, чтобы анонимный опрос не раскрыл список участников.
  const sweepPollDeadlines = () => {
    try { closeExpiredPolls(io); }
    catch (error) { console.error('Ошибка завершения опросов по сроку:', error); }
  };
  sweepPollDeadlines();
  const pollDeadlineTimer = setInterval(sweepPollDeadlines, 30_000);
  pollDeadlineTimer.unref?.();
});
