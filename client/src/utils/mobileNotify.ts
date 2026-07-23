import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const isNativeMobile = Capacitor.isNativePlatform();

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

export async function showMobileNotification(messageId: number, title: string, body: string) {
  if (!isNativeMobile) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: toNotificationId(messageId),
          title,
          body,
          smallIcon: 'ic_launcher_foreground'
        }
      ]
    });
  } catch (e) {
    console.error('Ошибка показа уведомления:', e);
  }
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
