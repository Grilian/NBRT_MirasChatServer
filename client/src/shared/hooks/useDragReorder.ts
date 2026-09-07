import { useEffect, useRef, useState } from 'react';

/**
 * Перестановка плиток перетаскиванием — общая механика для сеток админ-панели
 * (смайлики, стикеры). Вынесена из EmojiItemGrid без изменения поведения:
 * вторая копия этих восьмидесяти строк рядом со стикерами разъехалась бы с
 * оригиналом на первой же правке.
 *
 * Жест намеренно разный для мыши и пальца. Мышью — тянем сразу. Пальцем —
 * только после удержания: иначе первое же движение по сетке хватало бы плитку
 * вместо прокрутки страницы, и до нижних рядов было бы не добраться. Прокрутка
 * глушится своим НЕ-пассивным touchmove и только на время перетаскивания —
 * React вешает touchmove пассивно, и preventDefault из его обработчика не
 * работает вовсе (та же история, что с выделением сообщений в переписке).
 */

/** Сколько держать палец, прежде чем плитка «возьмётся». */
export const DRAG_HOLD_MS = 260;

interface Identifiable { id: number }

interface DragReorderOptions<T extends Identifiable> {
  items: T[];
  onReorder: (order: number[]) => void;
  /** Атрибут, по которому ищется плитка под пальцем. */
  dataAttribute: string;
  /** Нажали, но не потянули — это обычный тап по плитке. */
  onTap?: (item: T) => void;
}

export function useDragReorder<T extends Identifiable>({
  items, onReorder, dataAttribute, onTap,
}: DragReorderOptions<T>) {
  const [order, setOrder] = useState<T[]>(items);
  const [dragId, setDragId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; armed: boolean; moved: boolean; timer?: number } | null>(null);

  // Список принадлежит серверу: после любой его выдачи показываем её, иначе
  // локальный порядок разъехался бы с настоящим после загрузки или удаления.
  useEffect(() => { setOrder(items); }, [items]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const block = (e: TouchEvent) => { if (gesture.current?.armed) e.preventDefault(); };
    node.addEventListener('touchmove', block, { passive: false });
    return () => node.removeEventListener('touchmove', block);
  }, []);

  const finish = (commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.timer) window.clearTimeout(g.timer);
    setDragId(null);
    if (commit && g?.armed) onReorder(order.map((i) => i.id));
    return g;
  };

  const moveTo = (id: number, overId: number) => {
    if (id === overId) return;
    setOrder((prev) => {
      const from = prev.findIndex((i) => i.id === id);
      const to = prev.findIndex((i) => i.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  };

  const handlePointerDown = (e: React.PointerEvent, item: T) => {
    if (e.button != null && e.button !== 0) return;
    const armNow = e.pointerType === 'mouse';
    gesture.current = { id: item.id, armed: armNow, moved: false };
    if (armNow) {
      setDragId(item.id);
    } else {
      gesture.current.timer = window.setTimeout(() => {
        if (gesture.current && !gesture.current.moved) {
          gesture.current.armed = true;
          setDragId(item.id);
        }
      }, DRAG_HOLD_MS);
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.armed) {
      // Движение до срабатывания удержания — это прокрутка, а не перетаскивание.
      g.moved = true;
      if (g.timer) window.clearTimeout(g.timer);
      gesture.current = null;
      return;
    }
    g.moved = true;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(`[${dataAttribute}]`);
    const overId = under ? Number((under as HTMLElement).dataset[toDatasetKey(dataAttribute)]) : NaN;
    if (Number.isFinite(overId)) moveTo(g.id, overId);
  };

  const handlePointerUp = (item: T) => {
    const g = finish(true);
    // Не тянули, а просто нажали — это тап.
    if (g && !g.moved) onTap?.(item);
  };

  return {
    order,
    dragId,
    containerRef,
    tileHandlers: (item: T) => ({
      onPointerDown: (e: React.PointerEvent) => handlePointerDown(e, item),
      onPointerMove: handlePointerMove,
      onPointerUp: () => handlePointerUp(item),
      onPointerCancel: () => finish(false),
    }),
  };
}

/** `data-emoji-id` → `emojiId`: dataset хранит ключи в camelCase. */
function toDatasetKey(attribute: string): string {
  return attribute
    .replace(/^data-/, '')
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
