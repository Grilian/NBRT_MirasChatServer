// Контраст палитры.
//
// 07.09.2026 контраст был замерен по живому экрану обходом всех видимых
// текстовых узлов: нашлось 24 нарушения в светлой теме и 4 в тёмной. Значения
// подобраны расчётом и сведены к нулю нарушений в обеих.
//
// Этот тест держит их на месте. Он читает НАСТОЯЩИЙ tokens.css, а не копию
// значений: копия разошлась бы с файлом на первой же правке и молча зеленела.
// Проверяются пары «текст на фоне», которые в интерфейсе действительно
// встречаются, — список ниже и есть описание того, что где лежит.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
);

/** Значения палитры: `--_имя-light` / `--_имя-dark`. */
function palette(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of TOKENS.matchAll(/(--_[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const P = palette();

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminance(hex: string) {
  const { r, g, b } = rgb(hex);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Отношение яркостей по WCAG: от 1 (нет разницы) до 21 (чёрное на белом). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
const AA_TEXT = 4.5;

/** Пары, которые действительно встречаются на экране. */
const PAIRS: [string, string, string][] = [
  // [что за пара, токен текста, токен фона]
  ['приглушённый текст на панели, светлая', '--_ink-muted-light', '--_surface-light'],
  ['приглушённый текст на утопленной, светлая', '--_ink-muted-light', '--_surface-sunken-light'],
  ['бледный текст на панели, светлая', '--_ink-faint-light', '--_surface-light'],
  ['время в чужом пузыре, светлая', '--_meta-in-light', '--_bubble-in-light'],
  ['время в своём пузыре, светлая', '--_meta-out-light', '--_bubble-out-light'],
  ['галочка прочтения, светлая', '--_tick-read-light', '--_bubble-out-light'],

  ['приглушённый текст на панели, тёмная', '--_ink-muted-dark', '--_surface-dark'],
  ['приглушённый текст на утопленной, тёмная', '--_ink-muted-dark', '--_surface-sunken-dark'],
  ['бледный текст на панели, тёмная', '--_ink-faint-dark', '--_surface-dark'],
  ['время в чужом пузыре, тёмная', '--_meta-in-dark', '--_bubble-in-dark'],
  ['время в своём пузыре, тёмная', '--_meta-out-dark', '--_bubble-out-dark'],
];

/** Фоны, на которых лежит БЕЛЫЙ текст: выделенная строка, бейдж, разделитель. */
const WHITE_ON: [string, string][] = [
  ['выделенная строка списка, светлая', '--_accent-strong-light'],
  ['бейдж непрочитанного, светлая', '--_accent-strong-light'],
  ['разделитель дня, светлая', '--_day-sep-light'],
  ['выделенная строка списка, тёмная', '--_row-active-dark'],
  ['бейдж непрочитанного, тёмная', '--_accent-strong-dark'],
];

describe('контраст палитры', () => {
  test('палитра действительно прочиталась из tokens.css', () => {
    // Если разбор сломается, все проверки ниже станут бессмысленно зелёными.
    expect(Object.keys(P).length).toBeGreaterThan(30);
    expect(P['--_ink-muted-light']).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test.each(PAIRS)('%s — не ниже 4.5:1', (_name, fg, bg) => {
    expect(P[fg], `нет токена ${fg}`).toBeTruthy();
    expect(P[bg], `нет токена ${bg}`).toBeTruthy();
    expect(contrast(P[fg], P[bg])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test.each(WHITE_ON)('белый текст на «%s» — не ниже 4.5:1', (_name, bg) => {
    expect(P[bg], `нет токена ${bg}`).toBeTruthy();
    expect(contrast(WHITE, P[bg])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test('яркий акцент намеренно НЕ проходит под белый текст — для этого есть strong', () => {
    // Не оплошность, а разделение ролей: яркий синий нужен заливкам,
    // обводкам и значкам, где текста на нём нет. Там, где на акценте лежит
    // белая подпись, берётся --accent-strong. Проверка держит это различие
    // видимым: если однажды они сравняются, кто-то потерял одну из ролей.
    expect(contrast(WHITE, P['--_accent-light'])).toBeLessThan(AA_TEXT);
    expect(contrast(WHITE, P['--_accent-strong-light'])).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('палитра аватаров', () => {
  // Инициалы на подложке всегда белые, значит каждый цвет обязан проходить.
  test('на каждом цвете белые инициалы читаются', async () => {
    const { colorForName } = await import('@/shared/lib/avatar');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(colorForName(`имя${i}`));
    expect(seen.size).toBeGreaterThan(3);
    for (const color of seen) {
      expect(contrast(WHITE, color), `цвет ${color}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
