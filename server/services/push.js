const fs = require('fs');
const path = require('path');
// firebase-admin 14 отдаёт только модульный API: привычных admin.credential
// и admin.messaging() в корневом экспорте больше нет.
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
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
    const app = initializeApp({ credential: cert(credentials) });
    messaging = getMessaging(app);
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
async function notifyNewMessage(userId, {
  chatId, messageId, senderName, chatLabel, forceNotification = false, requiredFeature = null,
  threadRootId = null
}) {
  if (!messaging) return;

  try {
    const tokens = db
      .prepare('SELECT token, capabilities FROM device_tokens WHERE user_id = ?')
      .all(userId)
      .filter((row) => !requiredFeature || String(row.capabilities || '').split(',').includes(requiredFeature))
      .map((row) => row.token);

    if (!tokens.length) return;

    // chatLabel приходит только для общего чата и групп — там у сообщения
    // много получателей, и заголовок "Имя" один в один выглядел бы как
    // личное сообщение от этого человека, хотя видят его все участники.
    const title = chatLabel ? `${senderName || 'MirasChat'} · ${chatLabel}` : (senderName || 'MirasChat');

    const response = await messaging.sendEachForMulticast({
      tokens,
      data: {
        type: threadRootId ? 'thread_message' : 'new_message',
        chatId: String(chatId),
        messageId: String(messageId),
        ...(threadRootId ? { threadRootId: String(threadRootId) } : {}),
        forceNotification: forceNotification ? '1' : '0'
      },
      notification: {
        title,
        body: threadRootId ? 'Сообщение в ветке' : 'Новое сообщение'
      },
      android: {
        priority: 'high',
        notification: {
          channelId: CHANNEL_ID,
          icon: 'ic_launcher_foreground',
          // Уведомления одного чата складываются в стопку, а не сыплются
          // отдельными карточками — так же, как у локальных уведомлений.
          tag: threadRootId ? `thread_${threadRootId}` : 'chat_' + chatId
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


/**
 * Уведомление календаря — приглашение или напоминание.
 *
 * Отдельно от notifyNewMessage: у сообщений своя группировка по чату и свой
 * заголовок с именем отправителя, а тут в заголовке само событие. Общее у них
 * только то, как чистятся протухшие токены.
 */
async function notifyCalendar(userId, { type, title, body, eventId }) {
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
        type: String(type),
        eventId: String(eventId)
      },
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: CHANNEL_ID,
          icon: 'ic_launcher_foreground',
          // Своя стопка на событие: напоминание не должно смешиваться
          // с перепиской в одной группе уведомлений.
          tag: 'calendar_' + eventId
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
    console.error('[push] ошибка отправки уведомления календаря:', e.message);
  }
}

module.exports = { notifyNewMessage, notifyCalendar, isEnabled };
