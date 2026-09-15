export interface ScrollAnchorSnapshot {
  /** Верхнее сообщение на момент снимка — по нему видно, что страница реально пришла. */
  firstMessageId: string | null;
  /**
   * Высота содержимого ДО того, как страница встала в ленту.
   *
   * Обновляется на каждом событии прокрутки, пока ответ едет, — и это главное
   * в снимке. Прежняя версия запоминала положение якорного сообщения в момент
   * ЗАПРОСА и после ответа возвращала его туда же: всё, что человек успевал
   * пролистать за время ожидания (а на телефоне это инерционный бросок),
   * отматывалось назад. Прирост высоты от такого ожидания не зависит — он
   * прибавляется к ТЕКУЩЕЙ позиции, какой бы она ни стала.
   */
  scrollHeight: number;
}

export function didAppendNewestMessage(
  previousLength: number,
  currentLength: number,
  previousLastId: number | null,
  currentLastId: number | null,
  chatJustOpened: boolean,
): boolean {
  return !chatJustOpened && currentLength > previousLength && currentLastId !== previousLastId;
}

const messageNodes = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-msg-id]'));

export function captureScrollAnchor(container: HTMLElement): ScrollAnchorSnapshot {
  return {
    firstMessageId: messageNodes(container)[0]?.dataset.msgId || null,
    scrollHeight: container.scrollHeight,
  };
}

/**
 * Восстанавливает положение только после реального добавления сообщений СВЕРХУ.
 * Изменение высоты снизу (новое входящее, страница вниз) якорь не расходует:
 * там содержимое не съезжает и поправлять нечего.
 */
export function restoreScrollAnchor(container: HTMLElement, snapshot: ScrollAnchorSnapshot): boolean {
  if ((messageNodes(container)[0]?.dataset.msgId || null) === snapshot.firstMessageId) return false;

  container.scrollTop += Math.max(0, container.scrollHeight - snapshot.scrollHeight);
  return true;
}
