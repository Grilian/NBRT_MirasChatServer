import { registerBackInterceptor, runTopBackInterceptor } from './backInterceptors';

test('Back достаётся последнему открытому оверлею, а не первому', () => {
  const lightbox = jest.fn();
  const reactions = jest.fn();

  const releaseLightbox = registerBackInterceptor(lightbox);
  const releaseReactions = registerBackInterceptor(reactions);

  expect(runTopBackInterceptor()).toBe(true);
  expect(reactions).toHaveBeenCalledTimes(1);
  expect(lightbox).not.toHaveBeenCalled();

  releaseReactions();
  expect(runTopBackInterceptor()).toBe(true);
  expect(lightbox).toHaveBeenCalledTimes(1);

  releaseLightbox();
  // Ничего не открыто — событие не поглощаем, иначе Back перестал бы работать
  // вообще: цепочка навигации Chat.tsx до сворачивания приложения не дошла бы.
  expect(runTopBackInterceptor()).toBe(false);
});

test('снятие перехвата в произвольном порядке не задевает чужие', () => {
  const first = jest.fn();
  const second = jest.fn();

  const releaseFirst = registerBackInterceptor(first);
  const releaseSecond = registerBackInterceptor(second);

  // Нижний оверлей закрылся раньше верхнего — pop() снял бы не того.
  releaseFirst();
  expect(runTopBackInterceptor()).toBe(true);
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();

  expect(runTopBackInterceptor()).toBe(true);
  expect(second).toHaveBeenCalledTimes(2);

  // Стек — состояние уровня модуля: не снятый перехват утёк бы в следующий тест.
  releaseSecond();
});

test('повторное снятие перехвата ничего не ломает', () => {
  const handler = jest.fn();
  const release = registerBackInterceptor(handler);
  release();
  release();
  expect(runTopBackInterceptor()).toBe(false);
});
