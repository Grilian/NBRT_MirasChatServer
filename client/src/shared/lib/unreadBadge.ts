/**
 * Цвет метки непрочитанного.
 *
 * Метка по умолчанию была цветом акцента — тем же синим, что и вся оболочка,
 * и на синем же фоне выделенной строки терялась совсем: «плохо видны новые
 * сообщения в чатах» (жалоба пользователя 08.09.2026). Красный на синем не
 * теряется ни в одной теме.
 *
 * Хранится НА УСТРОЙСТВЕ, как тема и свёрнутость рельса: это настройка того,
 * как человеку удобнее смотреть, а не свойство его учётной записи. С телефона
 * и с компьютера один и тот же человек вполне может хотеть разного.
 *
 * Каждый цвет задан парой: для светлой темы темнее, для тёмной светлее. Иначе
 * либо белые цифры на нём не читаются, либо он сам выжигает глаз в темноте.
 */
export interface UnreadBadgeColor {
  id: string;
  label: string;
  light: string;
  dark: string;
}

export const UNREAD_BADGE_COLORS: UnreadBadgeColor[] = [
  { id: 'red', label: 'Красный', light: '#E13B32', dark: '#FF5A4E' },
  { id: 'orange', label: 'Оранжевый', light: '#D8600A', dark: '#FF9138' },
  { id: 'green', label: 'Зелёный', light: '#1F7A45', dark: '#3ECF77' },
  { id: 'violet', label: 'Фиолетовый', light: '#6E45C8', dark: '#A98BFF' },
  { id: 'blue', label: 'Синий', light: '#1E6FD9', dark: '#5AA9FF' },
];

/** Красный — по умолчанию: он единственный не совпадает с акцентом оболочки. */
export const DEFAULT_UNREAD_BADGE = 'red';

const STORAGE_KEY = 'unreadBadgeColor';

export function getUnreadBadgeColor(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && UNREAD_BADGE_COLORS.some((color) => color.id === stored)) return stored;
  } catch {
    // приватный режим — вернём умолчание, ронять запуск незачем
  }
  return DEFAULT_UNREAD_BADGE;
}

/**
 * Ставит выбранный цвет переменными на корень документа.
 *
 * Переменные ДВЕ, светлая и тёмная: сама тема переключается ниже по каскаду
 * (`prefers-color-scheme` и `data-theme`), и подставить одно значение значило
 * бы сломать вторую тему. Правило, которое из них взять, живёт в tokens.css
 * рядом с остальными цветами.
 */
export function applyUnreadBadgeColor(id: string): void {
  const color = UNREAD_BADGE_COLORS.find((item) => item.id === id) || UNREAD_BADGE_COLORS[0];
  try {
    localStorage.setItem(STORAGE_KEY, color.id);
  } catch {
    // не смогли запомнить — цвет всё равно применится на этот раз
  }
  const root = document.documentElement;
  root.style.setProperty('--unread-badge-light', color.light);
  root.style.setProperty('--unread-badge-dark', color.dark);
}
