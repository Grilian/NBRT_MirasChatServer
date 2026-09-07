import { useEffect, useRef, useState } from 'react';
import { LayoutInput, LayoutState, resolveLayout } from './layoutMode';

/**
 * Текущая раскладка приложения. Пересчитывается на изменение размера окна, но
 * состояние React меняется ТОЛЬКО когда меняется дискретный результат —
 * режим, компактность списка, видимость правой области.
 *
 * Это не преждевременная оптимизация: `Chat.tsx` — самый большой компонент
 * приложения, и перерисовывать его на каждый пиксель перетаскивания рамки
 * значит заставить окно ехать за курсором рывками. Непрерывную часть (сколько
 * именно пикселей достаётся списку и переписке) считает CSS-грид, ему для
 * этого React не нужен вовсе.
 */
export function useLayoutMode(input: Omit<LayoutInput, 'width'>): LayoutState {
  const currentWidth = () => (typeof window === 'undefined' ? 1280 : window.innerWidth);

  const [state, setState] = useState<LayoutState>(
    () => resolveLayout({ ...input, width: currentWidth() })
  );

  // Свежий ввод для обработчика resize: подписка живёт один раз, а ширина
  // списка и намерение открыть панель меняются независимо от неё.
  const inputRef = useRef(input);
  inputRef.current = input;

  const stateRef = useRef(state);
  stateRef.current = state;

  const apply = (next: LayoutState) => {
    const prev = stateRef.current;
    const sameShape = prev.mode === next.mode
      && prev.rosterCompact === next.rosterCompact
      && prev.rightPanelOpen === next.rightPanelOpen
      && prev.rightPanelAutoClosed === next.rightPanelAutoClosed;
    if (sameShape) return;
    stateRef.current = next;
    setState(next);
  };

  // Пересчёт при изменении входных данных (ширина списка, запрос панели).
  useEffect(() => {
    apply(resolveLayout({ ...input, width: currentWidth() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.rosterWidth, input.rightPanelRequested, input.rosterCollapsedByUser]);

  useEffect(() => {
    // Считаем синхронно, без requestAnimationFrame.
    //
    // Троттлить тут нечего: resolveLayout — чистая функция из четырёх сложений,
    // а от лишних перерисовок защищает сравнение дискретных полей выше, а не
    // задержка. Кадровая же отсрочка добавляла настоящую беду: rAF не
    // выполняется, пока окно не отрисовывается (свёрнутое, скрытая вкладка,
    // фоновый WebView) — приложение возвращалось бы к человеку с раскладкой от
    // прошлого размера окна.
    const recompute = () => apply(resolveLayout({ ...inputRef.current, width: currentWidth() }));

    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
