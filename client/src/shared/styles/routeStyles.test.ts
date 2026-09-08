import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Стили календаря приезжают ОТДЕЛЬНЫМ куском — вместе с самим календарём
 * (разделение по маршрутам, волна 9). Значит класс, объявленный только в
 * `calendar.css`, за пределами календаря работает через раз: если человек ещё
 * не заходил в календарь, оформления просто нет.
 *
 * Глазами это не ловится: у себя на машине календарь обычно уже открывали, и
 * стиль «есть». Поймано на живой сборке 08.09.2026 — в окне задачи кнопки
 * «Удалить» и «Сохранить» встали столбиком без отступов, потому что ряд
 * действий был описан классом из календаря.
 */
const SRC = join(__dirname, '..', '..');
const CALENDAR_CSS = join(SRC, 'features', 'calendar', 'calendar.css');
const SHARED_STYLES = join(SRC, 'shared', 'styles');

/** Имена классов, объявленных в файле. */
function classesIn(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (entry.endsWith('.tsx') && !entry.includes('.test.')) found.push(full);
  }
  return found;
}

test('вне календаря не используются классы, которые едут только с календарём', () => {
  const calendarOnly = classesIn(readFileSync(CALENDAR_CSS, 'utf8'));
  for (const file of readdirSync(SHARED_STYLES).filter((f) => f.endsWith('.css'))) {
    for (const name of classesIn(readFileSync(join(SHARED_STYLES, file), 'utf8'))) {
      calendarOnly.delete(name);
    }
  }

  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.split(sep + 'src' + sep)[1].split(sep).join('/');
    if (rel.startsWith('features/calendar/')) continue;
    const source = readFileSync(file, 'utf8');
    for (const name of calendarOnly) {
      // Ищем как отдельное слово в строке класса, чтобы `has-local-preview`
      // не считался использованием `cal-preview`.
      if (new RegExp(`["'\s]${name}["'\s]`).test(source)) offenders.push(`${rel}: ${name}`);
    }
  }

  expect(offenders).toEqual([]);
});
