const { notifyNewMessage } = require('../services/push');

// Кто сейчас на связи, кто свернул приложение и какие пуши отложены.
//
// Состояние живёт в памяти процесса и специально не хранится в базе:
// перезапуск сервера означает, что все сокеты отвалились, — восстанавливать
// тут нечего.
// ===== WebSocket =====
// userId -> Set<socketId>. Раньше здесь был Map userId -> socketId, и это
// ломалось при нескольких сессиях одного человека (вторая вкладка, телефон
// плюс десктоп, а также momentary-переподключение, когда новый сокет успевает
// подняться раньше, чем отвалится старый): вход со второго устройства затирал
// запись первого, а его 'disconnect' затем помечал пользователя оффлайн,
// хотя он оставался на связи. Отсюда мигающий индикатор "в сети" и, что
// важнее, recipientOnline === false — сообщение не помечалось доставленным.
const onlineSockets = new Map();

function markSocketOnline(userId, socketId) {
  const existing = onlineSockets.get(userId);
  if (existing) existing.add(socketId);
  else onlineSockets.set(userId, new Set([socketId]));
}

// Возвращает true, если это была последняя живая сессия пользователя, то есть
// он действительно ушёл в оффлайн (а не просто закрыл одну из вкладок).
function markSocketOffline(userId, socketId) {
  const sockets = onlineSockets.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size > 0) return false;
  onlineSockets.delete(userId);
  return true;
}

const onlineUserIds = () => Array.from(onlineSockets.keys());
const isUserOnline = (userId) => onlineSockets.has(Number(userId));

// Сокеты приложений, ушедших в фон (Android свернули кнопкой «Домой»).
//
// Живой сокет сам по себе НЕ значит, что человеку есть чем показать
// уведомление: свёрнутый на Android WebView замораживает таймеры и JS, и
// клиент физически не обработает пришедшее сообщение — а сокет при этом
// висит подключённым ещё десятки секунд (пока не отвалится по pingTimeout),
// и всё это время сервер считал получателя онлайн и пуш не слал. В итоге
// уведомление не показывал никто: ни клиент (заморожен), ни сервер (думал,
// что клиент сам справится). Приложение само сообщает о переходе в фон
// событием 'app_state', и для решения «слать ли пуш» верить надо ему.
const backgroundedSockets = new Set();

/** Есть ли у человека сокет, который прямо сейчас способен показать уведомление сам. */
function canReceiveInApp(userId) {
  const sockets = onlineSockets.get(Number(userId));
  if (!sockets) return false;
  for (const socketId of sockets) {
    if (!backgroundedSockets.has(socketId)) return true;
  }
  return false;
}

// ДВА уведомления на одно сообщение — отсюда.
//
// Android сообщает о сворачивании сразу (app_state), но JS в свёрнутом WebView
// замирает НЕ сразу: секунды, а иногда и минуты приложение продолжает получать
// сокет-события и рисовать локальные уведомления само. Сервер в этот момент уже
// считал клиента неспособным показать уведомление и слал пуш — в шторке
// оказывались обе карточки (у них разная природа: локальная адресуется по id
// сообщения, пуш — по tag чата, и Android не схлопывает их в одну).
//
// Наоборот тоже нельзя: дождаться, пока сокет отвалится по pingTimeout, значит
// потерять уведомление у тех, кого система заморозила молча.
//
// Поэтому свёрнутому, но ещё живому клиенту пуш ОТКЛАДЫВАЕТСЯ: успел показать
// сам — присылает 'message_notified', и отложенный пуш снимается; замер —
// пуш уходит с небольшим опозданием. Тем, у кого сокета нет вовсе, шлём сразу:
// подтверждать там некому, и ждать нечего.
const PUSH_GRACE_MS = 3000;
const pendingPushes = new Map();

const pushKey = (userId, messageId) => `${userId}:${messageId}`;

function schedulePush(userId, payload, { defer }) {
  if (!defer) {
    notifyNewMessage(userId, payload);
    return;
  }
  const key = pushKey(userId, payload.messageId);
  if (pendingPushes.has(key)) return;
  const timer = setTimeout(() => {
    pendingPushes.delete(key);
    notifyNewMessage(userId, payload);
  }, PUSH_GRACE_MS);
  // Отложенный пуш не должен держать процесс живым при остановке сервера.
  if (typeof timer.unref === 'function') timer.unref();
  pendingPushes.set(key, timer);
}

/** Клиент показал уведомление сам — дублировать его пушем больше не нужно. */
function cancelPendingPush(userId, messageId) {
  const key = pushKey(userId, messageId);
  const timer = pendingPushes.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingPushes.delete(key);
}

/** Пометить сокет как ушедший в фон (или вернувшийся). */
function setBackgrounded(socketId, backgrounded) {
  if (backgrounded) backgroundedSockets.add(socketId);
  else backgroundedSockets.delete(socketId);
}

/** Забыть сокет целиком — при отключении. */
function forgetSocket(socketId) {
  backgroundedSockets.delete(socketId);
}

module.exports = {
  markSocketOnline,
  markSocketOffline,
  onlineUserIds,
  isUserOnline,
  canReceiveInApp,
  setBackgrounded,
  forgetSocket,
  schedulePush,
  cancelPendingPush,
};
