const GESTURE_TAIL_EVENTS = [
  'pointerup', 'pointercancel',
  'touchstart', 'touchend', 'touchcancel',
  'mousedown', 'mouseup',
  'click', 'auxclick', 'contextmenu',
] as const;

const GESTURE_END_EVENTS = new Set([
  'pointerup', 'pointercancel',
  'touchend', 'touchcancel',
  'mouseup',
]);

/**
 * Закрывает компактный всплывающий слой первым внешним жестом и поглощает
 * весь остаток ЭТОГО ЖЕ жеста.
 *
 * На Android один тап приходит не одним событием, а цепочкой pointer/touch/
 * mouse. Если погасить только pointerdown и следующий click, промежуточный
 * touchstart успевает завести жест сообщения, а touchend открывает уже новое
 * контекстное меню после закрытия старого. Временный барьер висит на window —
 * раньше React — и не даёт хвосту жеста попасть в размонтировавшийся слой или
 * элементы под ним.
 */
export function dismissLayerWithoutUnderlayActivation(event: Event, onDismiss: () => void): void {
  event.preventDefault();
  event.stopPropagation();
  if ('stopImmediatePropagation' in event) event.stopImmediatePropagation();

  const documentRef = (event.target as Node | null)?.ownerDocument || document;
  const windowRef = documentRef.defaultView || window;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    GESTURE_TAIL_EVENTS.forEach((type) => windowRef.removeEventListener(type, swallowGestureTail, true));
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    if (finishTimer !== null) clearTimeout(finishTimer);
    fallbackTimer = null;
    finishTimer = null;
  };
  const swallowGestureTail = (tailEvent: Event) => {
    tailEvent.preventDefault();
    tailEvent.stopPropagation();
    if ('stopImmediatePropagation' in tailEvent) tailEvent.stopImmediatePropagation();

    // click/contextmenu — последний совместимый сигнал одного физического
    // нажатия. До него барьер не снимаем: между pointerup и click браузер ещё
    // способен прислать mouseup тому, что только что оказалось под пальцем.
    if (tailEvent.type === 'click' || tailEvent.type === 'auxclick' || tailEvent.type === 'contextmenu') {
      cleanup();
      return;
    }

    // preventDefault на первом pointerdown может отменить синтетический click
    // целиком. Раньше в таком случае барьер жил ещё 900 мс и съедал начало
    // следующего, уже самостоятельного тапа. После окончания текущего жеста
    // оставляем лишь один короткий кадр на совместимые события и снимаемся.
    if (GESTURE_END_EVENTS.has(tailEvent.type) && finishTimer === null) {
      finishTimer = setTimeout(cleanup, 32);
    }
  };

  GESTURE_TAIL_EVENTS.forEach((type) => windowRef.addEventListener(type, swallowGestureTail, true));
  // Резерв только для оборванного системой жеста, у которого не пришёл ни
  // один terminal event. Обычный тап снимает барьер через 32 мс после release.
  fallbackTimer = setTimeout(cleanup, 400);
  onDismiss();
}
