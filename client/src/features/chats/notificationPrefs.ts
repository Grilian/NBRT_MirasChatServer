// Настройки уведомлений живут в localStorage: сервер о них ничего не знает,
// это выбор конкретного устройства (на рабочем компьютере звук может мешать,
// на телефоне — наоборот).

export interface NotificationPrefs {
  /** Показывать всплывающие уведомления о новых сообщениях */
  enabled: boolean;
  /** Звук при получении сообщения */
  sound: boolean;
  /**
   * Сколько миллисекунд висит всплывающее уведомление внутри приложения.
   * 0 — не убирать автоматически, пока человек сам не закроет.
   */
  durationMs: number;
  /** Дублировать системным уведомлением ОС (вне окна приложения) */
  system: boolean;
}

// По умолчанию — полминуты. Стандартные 4-5 секунд браузерного уведомления
// человек, отошедший от рабочего места, просто не застаёт: он возвращается и
// не знает, что ему писали.
export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  sound: true,
  durationMs: 30000,
  system: true,
};

export const DURATION_OPTIONS: { value: number; label: string }[] = [
  { value: 10000, label: '10 секунд' },
  { value: 30000, label: '30 секунд' },
  { value: 60000, label: '1 минута' },
  { value: 300000, label: '5 минут' },
  { value: 0, label: 'Не скрывать' },
];

const STORAGE_KEY = 'notificationPrefs';

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_PREFS.enabled,
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_PREFS.sound,
      durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : DEFAULT_PREFS.durationMs,
      system: typeof parsed.system === 'boolean' ? parsed.system : DEFAULT_PREFS.system,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // приватный режим/переполненное хранилище — не повод ронять приложение
  }
  window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT, { detail: prefs }));
}

// Настройки меняются в панели настроек, а читает их обработчик сообщений в
// Chat — связываем их через событие окна, чтобы не тащить контекст ради двух
// булевых флагов и чтобы изменение подхватывалось сразу, без перезахода.
export const PREFS_CHANGED_EVENT = 'miraschat:notification-prefs-changed';

export function onNotificationPrefsChanged(callback: (prefs: NotificationPrefs) => void): () => void {
  const handler = (e: Event) => callback((e as CustomEvent<NotificationPrefs>).detail);
  window.addEventListener(PREFS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PREFS_CHANGED_EVENT, handler);
}
