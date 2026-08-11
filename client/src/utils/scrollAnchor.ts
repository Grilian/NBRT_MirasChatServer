export interface ScrollAnchorSnapshot {
  firstMessageId: string | null;
  anchorMessageId: string | null;
  anchorOffset: number;
  scrollHeight: number;
  scrollTop: number;
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

/** Сохраняет сообщение, которое пользователь видит у верхней границы ленты. */
export function captureScrollAnchor(container: HTMLElement): ScrollAnchorSnapshot {
  const nodes = messageNodes(container);
  const containerRect = container.getBoundingClientRect();
  const anchor = nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top) || null;

  return {
    firstMessageId: nodes[0]?.dataset.msgId || null,
    anchorMessageId: anchor?.dataset.msgId || null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - containerRect.top : 0,
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
}

/**
 * Восстанавливает положение только после реального добавления сообщений сверху.
 * Изменение высоты снизу (например, новое входящее сообщение) не расходует якорь.
 */
export function restoreScrollAnchor(container: HTMLElement, snapshot: ScrollAnchorSnapshot): boolean {
  const nodes = messageNodes(container);
  if ((nodes[0]?.dataset.msgId || null) === snapshot.firstMessageId) return false;

  const anchor = snapshot.anchorMessageId
    ? nodes.find((node) => node.dataset.msgId === snapshot.anchorMessageId)
    : null;

  if (anchor) {
    const currentOffset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += currentOffset - snapshot.anchorOffset;
  } else {
    container.scrollTop = snapshot.scrollTop + Math.max(0, container.scrollHeight - snapshot.scrollHeight);
  }
  return true;
}
