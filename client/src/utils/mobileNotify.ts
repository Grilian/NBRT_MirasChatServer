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

export async function showMobileNotification(messageId: number, title: string, body: string) {
  if (!isNativeMobile) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          // id уведомления должен быть 32-битным целым — берём остаток по модулю,
          // чтобы не переполниться на больших id сообщений
          id: messageId % 2147483647,
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
