import { describeTaskError } from './errors';

const withStatus = (status: number, error?: string) => ({ response: { status, data: error ? { error } : {} } });

test('человеческий ответ сервера показываем как есть', () => {
  expect(describeTaskError(withStatus(400, 'Укажите название'))).toBe('Укажите название');
});

test('текст исключения не показываем — он ничего не объясняет', () => {
  // Сервер на непредвиденном падении отдаёт e.message: «SQLITE_CONSTRAINT…»
  // человеку не говорит ни что случилось, ни что делать.
  const message = describeTaskError(withStatus(500, 'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'));
  expect(message).not.toContain('SQLITE');
  expect(message).toContain('Попробуйте ещё раз');
});

test('у каждого кода ответа своя понятная причина', () => {
  expect(describeTaskError(withStatus(403))).toContain('Недостаточно прав');
  expect(describeTaskError(withStatus(404))).toContain('удалили');
  expect(describeTaskError(withStatus(401))).toContain('войдите заново');
});

test('запрос не доехал — говорим про связь, а не про задачу', () => {
  expect(describeTaskError(new Error('Network Error'))).toContain('Нет связи с сервером');
});
