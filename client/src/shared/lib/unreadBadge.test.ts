import {
  DEFAULT_UNREAD_BADGE, UNREAD_BADGE_COLORS, applyUnreadBadgeColor, getUnreadBadgeColor,
} from './unreadBadge';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

test('по умолчанию метка красная — единственная, что не совпадает с акцентом', () => {
  // Прежний акцентный синий совпадал с цветом выделенной строки, и метка на
  // ней пропадала: «плохо видны новые сообщения в чатах» (08.09.2026).
  expect(getUnreadBadgeColor()).toBe(DEFAULT_UNREAD_BADGE);
  expect(DEFAULT_UNREAD_BADGE).toBe('red');
});

test('выбор запоминается и переживает перезаход', () => {
  applyUnreadBadgeColor('green');
  expect(getUnreadBadgeColor()).toBe('green');
});

test('ставятся ОБА варианта цвета — светлый и тёмный', () => {
  // Подставить одно значение значило бы сломать вторую тему: какой из них
  // взять, решает каскад в tokens.css.
  applyUnreadBadgeColor('violet');
  const violet = UNREAD_BADGE_COLORS.find((c) => c.id === 'violet')!;
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--unread-badge-light')).toBe(violet.light);
  expect(style.getPropertyValue('--unread-badge-dark')).toBe(violet.dark);
});

test('мусор в хранилище не ломает запуск', () => {
  localStorage.setItem('unreadBadgeColor', 'цвет-которого-нет');
  expect(getUnreadBadgeColor()).toBe(DEFAULT_UNREAD_BADGE);
});

test('у каждого цвета есть пара под обе темы', () => {
  for (const color of UNREAD_BADGE_COLORS) {
    expect(color.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(color.dark).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(color.light).not.toBe(color.dark);
  }
});
