import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const isNativeMobile = Capacitor.isNativePlatform();

// Канал уведомлений с повышенной важностью (importance: 5) — без него Android
// кладёт уведомление молча в шторку, не показывая всплывающий баннер (heads-up).
// Важность канала нельзя поменять постфактум для уже созданного id, поэтому
// используем новый id, а не переиспользуем канал по умолчанию плагина
// (тот был создан с обычной важностью ещё на предыдущих установках).
const MESSAGE_CHANNEL_ID = 'messages_v2';

// Веб-уведомления (Notification API) внутри Android WebView не долетают до
// системного трея — нужен нативный мост через Capacitor. На вебе/десктопе
// эта функция ничего не делает, там продолжает работать обычный Notification.
export async function ensureMobileNotificationPermission() {
  if (!isNativeMobile) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }
    await LocalNotifications.createChannel({
      id: MESSAGE_CHANNEL_ID,
      name: 'Сообщения',
      description: 'Новые сообщения в чате',
      importance: 5,
      visibility: 1,
      vibration: true,
    });
  } catch (e) {
    console.error('Ошибка запроса разрешения на уведомления:', e);
  }
}

// id уведомления должен быть 32-битным целым — берём остаток по модулю,
// чтобы не переполниться на больших id сообщений. Используем один и тот же
// маппинг и при показе, и при снятии, иначе прочитанное сообщение не
// найдёт своё уведомление в трее.
function toNotificationId(messageId: number) {
  return messageId % 2147483647;
}

export async function showMobileNotification(messageId: number, title: string, body: string, chatId: string) {
  if (!isNativeMobile) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: toNotificationId(messageId),
          title,
          body,
          smallIcon: 'ic_launcher_foreground',
          channelId: MESSAGE_CHANNEL_ID,
          extra: { chatId }
        }
      ]
    });
  } catch (e) {
    console.error('Ошибка показа уведомления:', e);
  }
}

// Тап по уведомлению в шторке — переходим в нужный чат. Возвращает функцию
// отписки; вызывающий должен снять слушатель при размонтировании.
export function onMobileNotificationTap(callback: (chatId: string) => void): () => void {
  if (!isNativeMobile) return () => {};

  const listenerPromise = LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
    const chatId = action.notification?.extra?.chatId;
    if (chatId) callback(chatId);
  });

  return () => { listenerPromise.then((h) => h.remove()); };
}

// Снимаем уведомление(я) из системного трея при прочтении сообщения в приложении —
// иначе бейдж на значке и запись в шторке продолжают висеть, хотя сообщение уже прочитано.
export async function dismissMobileNotifications(messageIds: number[]) {
  if (!isNativeMobile || messageIds.length === 0) return;
  try {
    const targetIds = new Set(messageIds.map(toNotificationId));
    const { notifications } = await LocalNotifications.getDeliveredNotifications();
    const toRemove = notifications.filter((n) => targetIds.has(n.id));
    if (toRemove.length > 0) {
      await LocalNotifications.removeDeliveredNotifications({ notifications: toRemove });
    }
  } catch (e) {
    console.error('Ошибка снятия уведомлений:', e);
  }
}

export async function dismissAllMobileNotifications() {
  if (!isNativeMobile) return;
  try {
    await LocalNotifications.removeAllDeliveredNotifications();
  } catch (e) {
    console.error('Ошибка снятия уведомлений:', e);
  }
}
