import { useCallback, useRef, useState } from 'react';

// Отклик на действие, которое ничего не делает.
//
// Прокрутка вверх, когда список и так наверху, — самый частый пример: палец
// тянет, а на экране ничего. Это читается как «приложение зависло», хотя всё
// в порядке. Мягкое смещение содержимого с возвратом отвечает на жест, ничего
// при этом не меняя: «мы вас поняли, дальше некуда».
//
// Сознательно НЕ анимация «на всякий случай»: она появляется только там, где
// действие невозможно, и гаснет сама. Постоянное подрагивание раздражало бы
// сильнее, чем отсутствие ответа.

export type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

export interface EdgeFeedback {
  /** Сторона, в которую сейчас «упёрлись», или null. */
  edge: EdgeSide | null;
  /** Насколько оттянули, 0…1 — для плавного смещения под пальцем. */
  pull: number;
  /** Класс для контейнера: показывает упор без своей разметки. */
  className: string;
  /** Отметить упор — вызывается из обработчика прокрутки или жеста. */
  hit: (side: EdgeSide, amount?: number) => void;
  /** Отпустили палец — смещение возвращается на место. */
  release: () => void;
}

const DECAY_MS = 260;

export function useEdgeFeedback(): EdgeFeedback {
  const [edge, setEdge] = useState<EdgeSide | null>(null);
  const [pull, setPull] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hit = useCallback((side: EdgeSide, amount = 1) => {
    setEdge(side);
    // Больше единицы не растягиваем: жест сильнее не значит «уехать дальше»,
    // предел упора один и тот же.
    setPull(Math.max(0, Math.min(1, amount)));
    if (timer.current) clearTimeout(timer.current);
    // Страховка на случай, если отпускание пальца не придёт (жест перехватила
    // система): подсветка упора не должна залипнуть навсегда.
    timer.current = setTimeout(() => { setEdge(null); setPull(0); }, DECAY_MS * 4);
  }, []);

  const release = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPull(0);
    timer.current = setTimeout(() => setEdge(null), DECAY_MS);
  }, []);

  return {
    edge,
    pull,
    className: edge ? `is-edge is-edge-${edge}` : '',
    hit,
    release,
  };
}
