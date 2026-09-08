import { plural } from './plural';

const tasks = (n: number) => `${n} ${plural(n, 'задача', 'задачи', 'задач')}`;

test('обычные окончания', () => {
  expect(tasks(1)).toBe('1 задача');
  expect(tasks(2)).toBe('2 задачи');
  expect(tasks(4)).toBe('4 задачи');
  expect(tasks(5)).toBe('5 задач');
  expect(tasks(0)).toBe('0 задач');
});

test('одиннадцать — четырнадцать не идут по последней цифре', () => {
  // Место, где правило ошибается чаще всего: 11 кончается на 1, но это «задач».
  expect(tasks(11)).toBe('11 задач');
  expect(tasks(12)).toBe('12 задач');
  expect(tasks(14)).toBe('14 задач');
  expect(tasks(111)).toBe('111 задач');
});

test('за сотней счёт идёт по последним двум цифрам', () => {
  expect(tasks(21)).toBe('21 задача');
  expect(tasks(102)).toBe('102 задачи');
  expect(tasks(105)).toBe('105 задач');
});
