import { useEffect, useRef } from 'react';
import { registerBackInterceptor } from '@/shared/hooks/backInterceptors';
import { acquireStandardKeyboardResizeMode } from '@/shared/platform/mobileKeyboard';

/**
 * Обвязка поверхности, которую закрывают: окна, шторки, выезжающие панели.
 *
 * Три вещи, которые раньше каждая такая поверхность помнила сама — и каждая
 * забывала свою:
 *
 * 1. **Режим клавиатуры Android.** Пока открыта переписка, приложение держит
 *    `adjustNothing`: композер двигает себя сам. Поверхность сверху об этом не
 *    знает, WebView под клавиатуру не сжимается, и её низ уходит под IME.
 * 2. **Аппаратный «Назад».** Не встроенная в цепочку поверхность закрывалась
 *    не первой: Back уводил экран из-под неё, а она оставалась висеть.
 * 3. **Escape.**
 *
 * Обработчик берётся СВЕЖИЙ на каждый вызов: подписки ставятся один раз, а
 * `onClose` у вызывающего кода пересоздаётся на каждой отрисовке — иначе
 * поверхность закрывала бы себя устаревшей функцией.
 */
export function useDismissibleLayer(onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const release = acquireStandardKeyboardResizeMode();
    const unregister = registerBackInterceptor(() => { closeRef.current(); return true; });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      unregister();
      release();
    };
  }, []);
}
