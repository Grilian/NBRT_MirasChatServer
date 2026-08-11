/**
 * Закрывает компактный всплывающий слой первым внешним жестом и поглощает
 * следующий click. Без второй части браузер успевает после размонтирования слоя
 * отправить click кнопке или ссылке, которая находилась под ним.
 */
export function dismissLayerWithoutUnderlayActivation(event: Event, onDismiss: () => void): void {
  event.preventDefault();
  event.stopPropagation();
  if ('stopImmediatePropagation' in event) event.stopImmediatePropagation();

  const documentRef = (event.target as Node | null)?.ownerDocument || document;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    documentRef.removeEventListener('click', swallowClick, true);
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const swallowClick = (clickEvent: Event) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    if ('stopImmediatePropagation' in clickEvent) clickEvent.stopImmediatePropagation();
    cleanup();
  };

  documentRef.addEventListener('click', swallowClick, true);
  timer = setTimeout(cleanup, 800);
  onDismiss();
}
