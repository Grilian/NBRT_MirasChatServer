// Настройки интерфейса — как и уведомления, живут в localStorage и
// принадлежат конкретному устройству: ширина панели на широком мониторе и на
// ноутбуке нужна разная, а сервер про экран ничего не знает.

export interface UiPrefs {
  /**
   * Жёстко группировать контакты по группам (разделами «Администрация»,
   * «Кафедры» и т.п.). По умолчанию выключено: основной порядок — по свежести
   * переписки, а разделы разрывают его и уводят собеседника, которому только
   * что написали, куда-то вниз списка.
   */
  groupContacts: boolean;
  /** Ширина списка чатов на широком экране, px. */
  rosterWidth: number;
}

export const ROSTER_MIN_WIDTH = 240;
export const ROSTER_MAX_WIDTH = 560;

export const DEFAULT_UI_PREFS: UiPrefs = {
  groupContacts: false,
  rosterWidth: 320,
};

const STORAGE_KEY = 'uiPrefs';

function clampWidth(value: number): number {
  return Math.min(ROSTER_MAX_WIDTH, Math.max(ROSTER_MIN_WIDTH, Math.round(value)));
}

export function getUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw);
    return {
      groupContacts: typeof parsed.groupContacts === 'boolean' ? parsed.groupContacts : DEFAULT_UI_PREFS.groupContacts,
      rosterWidth: typeof parsed.rosterWidth === 'number' ? clampWidth(parsed.rosterWidth) : DEFAULT_UI_PREFS.rosterWidth,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function saveUiPrefs(prefs: UiPrefs): void {
  const normalized: UiPrefs = { ...prefs, rosterWidth: clampWidth(prefs.rosterWidth) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // приватный режим/переполненное хранилище — не повод ронять приложение
  }
  window.dispatchEvent(new CustomEvent(UI_PREFS_CHANGED_EVENT, { detail: normalized }));
}

// Меняются в настройках, а читает их список чатов — связываем событием окна,
// как и настройки уведомлений, чтобы изменение подхватывалось сразу.
export const UI_PREFS_CHANGED_EVENT = 'miraschat:ui-prefs-changed';

export function onUiPrefsChanged(callback: (prefs: UiPrefs) => void): () => void {
  const handler = (e: Event) => callback((e as CustomEvent<UiPrefs>).detail);
  window.addEventListener(UI_PREFS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(UI_PREFS_CHANGED_EVENT, handler);
}
