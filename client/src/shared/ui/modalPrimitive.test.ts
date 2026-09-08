import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Окно заводится ТОЛЬКО через `Modal`/`Sheet` — правило из CLAUDE.md, и
 * проверять его глазами бесполезно: собранное руками наложение выглядит ровно
 * так же, а не работает при этом «Назад», Escape и режим клавиатуры Android.
 * Забывается это молча, а находится через месяц на телефоне.
 *
 * Ровно так и вышло: `TaskDialog`, `EventDialog`, карточка события в
 * календаре, шторка меню и два окна панели управления были собраны мимо
 * примитива. Окна задачи и события открываются на телефоне — там клавиатура
 * закрывала поле ввода, а «Назад» уводил из раздела вместе с набранным
 * текстом.
 */
const SRC = join(__dirname, '..', '..');
/** Сам примитив и этот тест — единственные места, где слово встречается. */
const ALLOWED = ['shared/ui/Modal.tsx', 'shared/ui/modalPrimitive.test.ts'];

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/** Путь от `src/` через прямой слэш — чтобы сообщение об ошибке читалось. */
function relative(file: string): string {
  return file.split(sep + 'src' + sep)[1].split(sep).join('/');
}

test('наложение окна рисует только примитив', () => {
  const offenders = walk(SRC)
    .map(relative)
    .filter((rel) => !ALLOWED.includes(rel))
    .filter((rel) => /className=["'{][^\n]*modal-overlay/.test(readFileSync(join(SRC, ...rel.split('/')), 'utf8')));

  expect(offenders).toEqual([]);
});
