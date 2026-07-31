// Системные уведомления браузера/Electron. Мобильный (Capacitor) путь живёт
// отдельно в mobileNotify.ts — там нужен нативный мост, обычный Notification
// внутри Android WebView до системного трея не добирается.

// В Electron уведомления показывает главный процесс через IPC.
//
// Причина: окно грузится через loadFile(), то есть с origin file://, который
// Chromium считает небезопасным контекстом — Notification API там запрещён
// наглухо, Notification.permission навсегда 'denied', и запросить разрешение
// невозможно. Поэтому на десктопе системные уведомления не появлялись вовсе.
// У главного процесса Electron таких ограничений нет.
const electronNotify = typeof window !== 'undefined' && window.electronAPI?.showNotification
  ? window.electronAPI
  : null;

export function canUseDesktopNotifications(): boolean {
  if (electronNotify) return true;
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopNotificationPermission(): NotificationPermission | 'unsupported' {
  // В Electron разрешение спрашивать не у кого — уведомления рисует сама ОС
  // через главный процесс, и отказать может только системная настройка Windows.
  if (electronNotify) return 'granted';
  if (!canUseDesktopNotifications()) return 'unsupported';
  return Notification.permission;
}

export async function ensureDesktopNotificationPermission(): Promise<boolean> {
  if (electronNotify) return true;
  if (!canUseDesktopNotifications()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

interface DesktopNotificationOptions {
  title: string;
  body: string;
  /** Уведомления из одного чата схлопываются в одно, как в Telegram */
  tag: string;
  icon?: string | null;
  onClick?: () => void;
}

// Живые ссылки на показанные уведомления. Без этого сборщик мусора может
// собрать объект Notification вместе с его onclick, и клик по уведомлению
// (особенно по «долгоживущему», ради которого всё и затевалось) просто
// ничего не делает.
const liveNotifications = new Map<string, Notification>();

// Клики по уведомлениям Electron приходят одним событием на все уведомления —
// раскладываем их обратно по чатам через tag.
const electronClickHandlers = new Map<string, () => void>();

if (electronNotify?.onNotificationClick) {
  electronNotify.onNotificationClick((tag: string) => {
    const handler = electronClickHandlers.get(tag);
    electronClickHandlers.delete(tag);
    handler?.();
  });
}

export function showDesktopNotification({ title, body, tag, icon, onClick }: DesktopNotificationOptions): void {
  if (electronNotify) {
    if (onClick) electronClickHandlers.set(tag, onClick);
    electronNotify.showNotification!({ title, body, tag });
    return;
  }

  if (!canUseDesktopNotifications() || Notification.permission !== 'granted') return;

  try {
    // Предыдущее уведомление из того же чата закрываем сами: renotify без
    // явного close в части браузеров оставляет оба висеть в центре уведомлений.
    liveNotifications.get(tag)?.close();

    const notification = new Notification(title, {
      body,
      tag,
      icon: icon || '/logo192.png',
      // Ключевое для «человек отошёл и не увидел»: без requireInteraction
      // системное уведомление само исчезает через 4-5 секунд. С ним оно висит,
      // пока его не закроют. Свойство есть не во всех типах TS-lib и не во всех
      // браузерах — где не поддерживается, просто игнорируется.
      requireInteraction: true,
      renotify: true,
      silent: true, // свой звук играем сами, чтобы он был одинаковым везде
    } as NotificationOptions & { requireInteraction: boolean; renotify: boolean });

    liveNotifications.set(tag, notification);

    notification.onclick = () => {
      onClick?.();
      notification.close();
    };
    notification.onclose = () => {
      if (liveNotifications.get(tag) === notification) liveNotifications.delete(tag);
    };
  } catch {
    // Некоторые сборки Electron/браузеров бросают, если ОС запретила
    // уведомления на системном уровне — внутриприложенческий тост всё равно
    // показывается, так что это не повод ничего ронять.
  }
}

/** Снять системное уведомление по чату — например, когда чат открыли и прочитали. */
export function dismissDesktopNotification(tag: string): void {
  if (electronNotify) {
    electronClickHandlers.delete(tag);
    electronNotify.closeNotification?.(tag);
    return;
  }
  const notification = liveNotifications.get(tag);
  if (notification) {
    notification.close();
    liveNotifications.delete(tag);
  }
}

export function dismissAllDesktopNotifications(): void {
  if (electronNotify) {
    electronClickHandlers.clear();
    electronNotify.closeAllNotifications?.();
    return;
  }
  liveNotifications.forEach((notification) => notification.close());
  liveNotifications.clear();
}
