const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const db = require('../db');

// Ключ сервисного аккаунта Firebase. В репозитории его нет и быть не должно —
// это доступ на отправку уведомлений от имени проекта. Путь задаётся в .env
// (FCM_SERVICE_ACCOUNT), по умолчанию ищем рядом с сервером.
const CREDENTIALS_PATH = process.env.FCM_SERVICE_ACCOUNT
  || path.join(__dirname, '..', 'fcm-service-account.json');

let messaging = null;

// Инициализация ленивая и необязательная: без ключа сервер обязан подниматься
// и работать как раньше, просто без пушей. Иначе забытый файл на проде valит
// весь мессенджер ради функции, которая всего лишь дублирует сокет.
(function initPush() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.warn('[push] ключ сервисного аккаунта не найден (' + CREDENTIALS_PATH + '), пуши отключены');
      return;
    }
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const app = admin.initializeApp({ credential: admin.credential.cert(credentials) });
    messaging = admin.messaging(app);
    console.log('[push] FCM подключён, проект ' + credentials.project_id);
  } catch (e) {
    console.error('[push] не удалось инициализировать FCM:', e.message);
  }
})();

function isEnabled() {
  return messaging !== null;
}

// Токены протухают сами (переустановка приложения, сброс данных, долгий
// простой). FCM сообщает об этом кодом ошибки на конкретный токен — такие
// сразу удаляем, иначе таблица растёт мусором, а каждая отправка тратится
// на заведомо мёртвые адреса.
const DEAD_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
];

function dropTokens(tokens) {
  if (!tokens.length) return;
  const stmt = db.prepare('DELETE FROM device_tokens WHERE token = ?');
  const dropAll = db.transaction((list) => list.forEach((t) => stmt.run(t)));
  dropAll(tokens);
}

// Канал должен совпадать с тем, что приложение создаёт при старте (см.
// mobileNotify.ts): у него importance 5, иначе Android положит уведомление
// в шторку молча, без всплывающего баннера.
const CHANNEL_ID = 'messages_v2';

/**
 * Уведомить пользователя о новом сообщении, когда его сокет мёртв.
 *
 * ВАЖНО про содержимое. Текст сообщения сюда намеренно не передаётся: в пуше
 * уходят только имя отправителя и идентификаторы, сам текст человек видит уже
 * в приложении, которое забирает его с нашего сервера. Так переписка не
 * проходит через инфраструктуру Google.
 *
 * Если когда-нибудь понадобится предпросмотр текста в шторке, как в Telegram —
 * это одна строка ниже (body). Но решение осознанное: тогда содержимое
 * внутренней переписки начнёт ходить через чужой сервис.
 *
 * Уведомление отправляем блоком notification, а не только data. Data-only
 * пуш обрабатывается плагином лишь тогда, когда приложение живо: в
 * MessagingService он уходит в PushNotificationsPlugin.sendRemoteMessage, и
 * при выгруженном приложении там некому его показать — сообщение просто
 * ложится в lastMessage до следующего запуска. Блок notification рисует
 * система, без участия нашего кода, и это работает даже когда процесс убит.
 *
 * priority: 'high' — иначе в Doze доставка откладывается до maintenance-окна,
 * то есть ровно в том случае, ради которого пуш и нужен.
 */
async function notifyNewMessage(userId, { chatId, messageId, senderName }) {
  if (!messaging) return;

  try {
    const tokens = db
      .prepare('SELECT token FROM device_tokens WHERE user_id = ?')
      .all(userId)
      .map((row) => row.token);

    if (!tokens.length) return;

    const response = await messaging.sendEachForMulticast({
      tokens,
      data: {
        type: 'new_message',
        chatId: String(chatId),
        messageId: String(messageId)
      },
      notification: {
        title: senderName || 'MirasChat',
        body: 'Новое сообщение'
      },
      android: {
        priority: 'high',
        notification: {
          channelId: CHANNEL_ID,
          icon: 'ic_launcher_foreground',
          // Уведомления одного чата складываются в стопку, а не сыплются
          // отдельными карточками — так же, как у локальных уведомлений.
          tag: 'chat_' + chatId
        }
      }
    });

    const dead = [];
    response.responses.forEach((r, i) => {
      if (!r.success && r.error && DEAD_TOKEN_CODES.includes(r.error.code)) {
        dead.push(tokens[i]);
      }
    });
    dropTokens(dead);
  } catch (e) {
    // Пуш — дублирующий канал: сокет и история сообщений от его отказа не
    // страдают, поэтому ошибку логируем и живём дальше.
    console.error('[push] ошибка отправки:', e.message);
  }
}

module.exports = { notifyNewMessage, isEnabled };
