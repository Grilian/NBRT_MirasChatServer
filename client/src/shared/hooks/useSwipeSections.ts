import { useRef } from 'react';

// Переключение вкладок смахиванием — только на узком экране.
//
// Жест обязан быть «дешёвым»: он делит экран с прокруткой списка (вертикаль),
// с горизонтальной лентой недавних чатов и с выделением сообщений в переписке.
// Поэтому срабатывает он лишь тогда, когда движение ЯВНО горизонтальное и
// достаточно длинное, а начато не внутри того, что само листается вбок.

/** Насколько горизонталь должна превосходить вертикаль, чтобы это был свайп вкладок. */
const DIRECTION_RATIO = 1.7;
/** Короткий рывок — это не переключение раздела, а промах по кнопке. */
const MIN_DISTANCE = 64;
/** Слишком долгий жест — человек что-то тянул, а не смахивал. */
const MAX_DURATION_MS = 700;

/** Элементы, внутри которых свайп вкладок не заводится вовсе. */
const BLOCKING_SELECTOR = [
  '.recent-chats',          // своя горизонтальная лента
  '.roster-filters',        // прокручиваемые чипы фильтров
  '.files-categories',
  '.attachments-categories',
  '.cal-grid-scroll',       // календарь листается своими жестами
  '.cal-month',
  '.conv-body',             // переписка: там выделение сообщений протяжкой
  '.composer',
  'input',
  'textarea',
  '[contenteditable="true"]',
].join(',');

export interface SwipeSectionsHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
}

/**
 * @param enabled  включать только там, где есть нижняя панель (узкий экран)
 * @param onSwipe  -1 — предыдущая вкладка, +1 — следующая
 */
export function useSwipeSections(enabled: boolean, onSwipe: (direction: -1 | 1) => void): SwipeSectionsHandlers {
  const start = useRef<{ x: number; y: number; at: number; blocked: boolean } | null>(null);

  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (!enabled || e.touches.length !== 1) { start.current = null; return; }
      const touch = e.touches[0];
      const target = e.target as HTMLElement | null;
      start.current = {
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now(),
        blocked: !!target?.closest(BLOCKING_SELECTOR),
      };
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const from = start.current;
      start.current = null;
      if (!from || from.blocked) return;
      if (Date.now() - from.at > MAX_DURATION_MS) return;

      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (Math.abs(dx) < MIN_DISTANCE) return;
      if (Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) return;

      // Смахнули влево — идём вправо по панели, как листают страницы.
      onSwipe(dx < 0 ? 1 : -1);
    },
  };
}
