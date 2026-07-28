import { RefObject, useEffect, useRef } from 'react';

// Листание колесом и свайпом. Вынесено отдельно, потому что правило тут одно и
// то же для всех представлений, а вот что считать «дальше» — у каждого своё
// (месяц, неделя, день), и это решает виджет.

// Порог накопленной прокрутки. Одного щелчка колеса мало: тачпад шлёт
// десятки мелких событий, и без накопления календарь пролистывал бы полгода
// от одного движения пальцем.
const WHEEL_THRESHOLD = 120;

// Пауза после перелистывания. Инерция тачпада продолжает слать события уже
// после того, как человек убрал руку, — без паузы они улетали бы дальше.
const COOLDOWN_MS = 320;

// Минимальная длина свайпа. Короче — это дрожание пальца при касании, а не
// намерение пролистать.
const SWIPE_MIN_PX = 48;

// Свайп должен быть заметно вертикальным: иначе горизонтальное движение по
// сетке недели засчитывалось бы как листание.
const SWIPE_VERTICAL_RATIO = 1.4;

interface StepGestureOptions {
  /**
   * Прокручиваемая область внутри (сетка времени). Пока она не исчерпана,
   * жест принадлежит ей: сначала человек долистывает сутки до края и только
   * потом переходит к следующей неделе.
   */
  scrollable?: () => HTMLElement | null;
  enabled?: boolean;
}

/**
 * Листание вперёд-назад колесом и вертикальным свайпом.
 *
 * @param onStep направление: +1 — дальше (вниз/от себя), -1 — назад.
 */
export function useStepGestures(
  target: RefObject<HTMLElement | null>,
  onStep: (direction: number) => void,
  options: StepGestureOptions = {}
): void {
  const { scrollable, enabled = true } = options;

  // Через ref, а не через замыкание: иначе обработчики пришлось бы
  // переподписывать на каждый рендер, теряя накопленную прокрутку.
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  const scrollableRef = useRef(scrollable);
  scrollableRef.current = scrollable;

  useEffect(() => {
    const node = target.current;
    if (!node || !enabled) return;

    let accumulated = 0;
    let lockedUntil = 0;
    let touchStartX = 0;
    let touchStartY = 0;

    // Край прокрутки внутренней области. Если её нет — жест сразу наш.
    const atEdge = (direction: number) => {
      const area = scrollableRef.current?.();
      if (!area) return true;
      // Единица допуска: дробные значения scrollTop при масштабировании
      // страницы не дают сравнению сойтись точно.
      if (direction > 0) return area.scrollTop + area.clientHeight >= area.scrollHeight - 1;
      return area.scrollTop <= 1;
    };

    const step = (direction: number) => {
      accumulated = 0;
      lockedUntil = Date.now() + COOLDOWN_MS;
      stepRef.current(direction);
    };

    const handleWheel = (event: WheelEvent) => {
      if (Date.now() < lockedUntil) return;

      const direction = Math.sign(event.deltaY);
      if (direction === 0) return;
      if (!atEdge(direction)) {
        accumulated = 0;
        return;
      }

      // Смена направления обнуляет накопленное: иначе «вниз-вниз-вверх»
      // сложилось бы в шаг вниз.
      if (Math.sign(accumulated) !== direction) accumulated = 0;
      accumulated += event.deltaY;

      if (Math.abs(accumulated) >= WHEEL_THRESHOLD) step(direction);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (Date.now() < lockedUntil) return;

      const touch = event.changedTouches[0];
      if (!touch) return;

      const deltaY = touch.clientY - touchStartY;
      const deltaX = touch.clientX - touchStartX;
      if (Math.abs(deltaY) < SWIPE_MIN_PX) return;
      if (Math.abs(deltaY) < Math.abs(deltaX) * SWIPE_VERTICAL_RATIO) return;

      // Палец вверх — содержимое уезжает вверх, значит показываем следующее.
      const direction = deltaY < 0 ? 1 : -1;
      if (!atEdge(direction)) return;

      step(direction);
    };

    // passive: колесо мы не отменяем, а только слушаем — так браузер не ждёт
    // решения обработчика и прокрутка внутренней сетки остаётся плавной.
    node.addEventListener('wheel', handleWheel, { passive: true });
    node.addEventListener('touchstart', handleTouchStart, { passive: true });
    node.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      node.removeEventListener('wheel', handleWheel);
      node.removeEventListener('touchstart', handleTouchStart);
      node.removeEventListener('touchend', handleTouchEnd);
    };
  }, [target, enabled]);
}

/**
 * Горячие клавиши, как в Google Calendar. Стрелки листают, T возвращает к
 * сегодня, М/Н/Д/Р переключают представления — вместе с латинскими раскладками,
 * потому что переключать раскладку ради горячей клавиши никто не станет.
 */
export function useCalendarKeys(handlers: {
  onStep: (direction: number) => void;
  onToday: () => void;
  onView: (view: 'month' | 'week' | 'day' | 'agenda') => void;
  enabled?: boolean;
}): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (handlers.enabled === false) return;

    const handleKey = (event: KeyboardEvent) => {
      // В поле ввода клавиши принадлежат тексту, а не календарю.
      const node = event.target as HTMLElement | null;
      const tag = node?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node?.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const { onStep, onToday, onView } = ref.current;

      switch (event.key) {
        case 'ArrowLeft': case 'ArrowUp': onStep(-1); break;
        case 'ArrowRight': case 'ArrowDown': onStep(1); break;
        case 't': case 'T': case 'е': case 'Е': onToday(); break;
        case 'm': case 'M': case 'ь': case 'Ь': onView('month'); break;
        case 'w': case 'W': case 'ц': case 'Ц': onView('week'); break;
        case 'd': case 'D': case 'в': case 'В': onView('day'); break;
        case 'a': case 'A': case 'ф': case 'Ф': onView('agenda'); break;
        default: return;
      }

      event.preventDefault();
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handlers.enabled]);
}
