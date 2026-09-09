import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Договор двух файлов: поле поиска в панели смайликов помечает себя
 * `data-keyboard-allowed`, а композер этот признак уважает.
 *
 * Пока панель открыта, композер намеренно гасит IME — тап по смайлику не
 * должен поднимать клавиатуру поверх панели. Но собственное поле поиска
 * попадало под то же правило: на Android клавиатура открывалась и мгновенно
 * закрывалась, набрать запрос было невозможно (жалоба с прода 09.09.2026).
 *
 * Проверяем чтением файлов: поведение живёт в нативных событиях Capacitor,
 * которых в jsdom нет вовсе, — тест на отрисовке зеленел бы, ничего не
 * проверяя. Сломать договор можно только правкой одного из двух мест, и тогда
 * этот тест упадёт.
 */
const SRC = join(__dirname, '..', '..');
const picker = readFileSync(join(SRC, 'features', 'emoji', 'EmojiPicker.tsx'), 'utf8');
const composer = readFileSync(join(SRC, 'features', 'chats', 'MessageInput.tsx'), 'utf8');

test('поле поиска смайликов просит клавиатуру явно', () => {
  expect(picker).toContain('data-keyboard-allowed');
});

test('композер не гасит IME у поля, которое его просит', () => {
  expect(composer).toContain("closest?.('[data-keyboard-allowed]')");
  // Признак обязан участвовать в самом условии, а не лежать рядом без дела.
  expect(composer).toMatch(/ownsFocusedField && !wantsKeyboard/);
});
