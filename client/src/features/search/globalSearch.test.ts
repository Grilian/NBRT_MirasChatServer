import { searchTargets, normalize, SearchTarget } from './globalSearch';

const t = (name: string, over: Partial<SearchTarget> = {}): SearchTarget => ({
  chatId: 'c_' + name, name, kind: 'person', ...over,
});

test('пустой запрос не показывает ничего — это подсказка, а не второй список', () => {
  expect(searchTargets([t('Анна'), t('Борис')], '')).toEqual([]);
  expect(searchTargets([t('Анна')], '   ')).toEqual([]);
});

test('совпадение с начала выигрывает у совпадения в середине', () => {
  // Человек, набравший три буквы, почти всегда набирает НАЧАЛО искомого.
  const hits = searchTargets([t('Александр Охотников'), t('Анна Петрова')], 'ан');
  expect(hits.map((h) => h.name)).toEqual(['Анна Петрова', 'Александр Охотников']);
});

test('начало слова ценнее середины слова', () => {
  const hits = searchTargets([t('Информационный отдел'), t('Отдел кадров')], 'отдел');
  expect(hits[0].name).toBe('Отдел кадров');
});

test('«ё» и «е» — одна буква', () => {
  // Иначе выдача, пустая на «Семенов», читается как «такого человека нет».
  expect(normalize('Семёнов')).toBe('семенов');
  expect(searchTargets([t('Семёнов Пётр')], 'семенов')).toHaveLength(1);
  expect(searchTargets([t('Семенов Петр')], 'семёнов')).toHaveLength(1);
});

test('ищем и по логину, но имя всегда выше', () => {
  // Логин помнят не хуже имени — в справочнике он у всех на виду. Но если
  // запрос совпал с чьим-то ИМЕНЕМ, этот человек и нужен.
  const byLogin = t('Борис Сотрудник', { username: 'petrov_b' });
  const byName = t('Petrova Anna', { username: 'anna' });
  const hits = searchTargets([byLogin, byName], 'petrov');
  expect(hits.map((h) => h.name)).toEqual(['Petrova Anna', 'Борис Сотрудник']);
  expect(hits[1].matched).toBe('username');
});

test('подразделение — последнее, чем можно совпасть', () => {
  const hits = searchTargets([t('Лия Р', { detail: 'Методисты' }), t('Методисты', { kind: 'group' })], 'методист');
  expect(hits[0].kind).toBe('group');
  expect(hits[1].matched).toBe('detail');
});

test('открытый чат ценнее карточки человека из справочника', () => {
  // Чат уже есть — человек идёт в него, а не заводит второй.
  const hits = searchTargets([
    t('Пётр', { kind: 'person' }),
    t('Пётр', { kind: 'chat', chatId: 'chat_1_2' }),
  ], 'пётр');
  expect(hits[0].chatId).toBe('chat_1_2');
});

test('служебные строки уходят вниз', () => {
  const hits = searchTargets([t('Следы', { kind: 'service' }), t('Следственный', { kind: 'group' })], 'след');
  expect(hits[0].kind).toBe('group');
});

test('выдача ограничена — больше это уже не подсказка', () => {
  const many = Array.from({ length: 30 }, (_, i) => t(`Анна ${i}`));
  expect(searchTargets(many, 'анна')).toHaveLength(8);
  expect(searchTargets(many, 'анна', 3)).toHaveLength(3);
});

test('регистр не имеет значения ни с одной стороны', () => {
  expect(searchTargets([t('ОБЩИЙ ЧАТ')], 'общий')).toHaveLength(1);
  expect(searchTargets([t('общий чат')], 'ОБЩИЙ')).toHaveLength(1);
});
