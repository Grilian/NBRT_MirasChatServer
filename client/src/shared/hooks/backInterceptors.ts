/**
 * Перехватчики аппаратной кнопки «Назад» для оверлеев, которые не подняты в
 * состояние Chat.tsx и потому не попадают в его цепочку разбора Back
 * (просмотр картинки, список поставивших реакцию — они живут внутри
 * ChatWindow). Без перехвата Back уводил экран из-под открытого оверлея, а сам
 * оверлей оставался висеть поверх уже другого экрана.
 *
 * Порядок строго LIFO: закрывается тот, кто открыт последним, — иначе Back
 * закрывал бы нижний оверлей, оставляя верхний.
 */
type BackInterceptor = () => void;

const stack: BackInterceptor[] = [];

/** Возвращает функцию отписки; вызывающий обязан снять перехват при размонтировании. */
export function registerBackInterceptor(handler: BackInterceptor): () => void {
  stack.push(handler);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Именно по значению, а не pop(): между регистрацией и снятием мог
    // открыться и ещё не закрыться другой оверлей.
    const index = stack.lastIndexOf(handler);
    if (index !== -1) stack.splice(index, 1);
  };
}

/**
 * Отдаёт Back верхнему перехватчику. `true` — событие поглощено, дальше по
 * цепочке навигации идти нельзя.
 */
export function runTopBackInterceptor(): boolean {
  const handler = stack[stack.length - 1];
  if (!handler) return false;
  handler();
  return true;
}
