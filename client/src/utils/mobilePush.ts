import { PushNotifications } from '@capacitor/push-notifications';
import { isNativeMobile } from './mobileNotify';
import api from '../api/client';

// Токен FCM держим в localStorage, чтобы при выходе из аккаунта знать, что
// именно снимать с регистрации: к моменту разлогина плагин уже мог переиздать
// токен, а снять надо ровно тот, который лежит на сервере.
const TOKEN_KEY = 'fcmToken';

async function registerToken(token: string) {
  try {
    await api.post('/devices', {
      token,
      platform: 'android',
      capabilities: ['threads', 'notification-policy'],
    });
    localStorage.setItem(TOKEN_KEY, token);
  } catch (e) {
    console.error('Ошибка регистрации токена уведомлений:', e);
  }
}

/**
 * Подписка на пуши. Зовём при каждом запуске приложения, а не только сразу
 * после логина: Firebase переиздаёт токен сам (переустановка, очистка данных,
 * восстановление из бэкапа), и пропущенное обновление означает, что человек
 * тихо перестаёт получать уведомления, ничего об этом не зная.
 *
 * onOpenChat вызывается при тапе по уведомлению из шторки — в том числе когда
 * приложение было выгружено и запускается этим тапом.
 *
 * Возвращает функцию отписки.
 */
export function initMobilePush(onOpenChat: (chatId: string) => void): () => void {
  if (!isNativeMobile) return () => {};

  const handles: Promise<{ remove: () => Promise<void> }>[] = [];

  handles.push(PushNotifications.addListener('registration', (token) => {
    registerToken(token.value);
  }));

  handles.push(PushNotifications.addListener('registrationError', (err) => {
    // Сюда попадаем, если на устройстве нет сервисов Google или проект
    // Firebase настроен неверно. Приложение при этом остаётся рабочим:
    // уведомления просто приходят пачкой при возврате в приложение.
    console.error('Ошибка регистрации в FCM:', JSON.stringify(err));
  }));

  handles.push(PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const chatId = action.notification?.data?.chatId;
    if (chatId) onOpenChat(chatId);
  }));

  // Пуш при живом приложении. Сервер шлёт его только тем, у кого нет сокета,
  // так что попасть сюда можно разве что в момент переподключения — тогда
  // сообщение и так приедет по сокету со всей нужной обвязкой. Показывать
  // ничего не надо, иначе получим вторую карточку на то же сообщение.
  handles.push(PushNotifications.addListener('pushNotificationReceived', () => {}));

  (async () => {
    try {
      let perm = await PushNotifications.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
        perm = await PushNotifications.requestPermissions();
      }
      if (perm.receive !== 'granted') return;
      await PushNotifications.register();
    } catch (e) {
      console.error('Ошибка подключения пуш-уведомлений:', e);
    }
  })();

  return () => { handles.forEach((h) => h.then((handle) => handle.remove())); };
}

/**
 * Снять устройство с регистрации при выходе из аккаунта — иначе на телефон
 * продолжат приходить пуши о сообщениях прежнему владельцу сессии.
 * Ждём ответ сервера: сразу после этого вызова localStorage чистится, и
 * отправить запрос уже будет нечем (в нём нужен токен авторизации).
 */
export async function unregisterMobilePush(): Promise<void> {
  if (!isNativeMobile) return;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;

  try {
    await api.delete('/devices', { data: { token } });
  } catch (e) {
    console.error('Ошибка снятия токена уведомлений:', e);
  }
}

// Снятие пушей из шторки. Уведомления от FCM живут отдельно от локальных, и
// getDeliveredNotifications у LocalNotifications их не видит — поэтому при
// прочтении надо гасить оба источника, иначе карточка остаётся висеть.
export async function dismissAllPushNotifications(): Promise<void> {
  if (!isNativeMobile) return;
  try {
    await PushNotifications.removeAllDeliveredNotifications();
  } catch (e) {
    console.error('Ошибка снятия пуш-уведомлений:', e);
  }
}
