import { Keyboard } from '@capacitor/keyboard';
import { isNativeMobile } from './mobileNotify';

// Открыта ли сейчас экранная клавиатура. Держим здесь, а не в состоянии React:
// значение нужно синхронно в момент навигации, до всякого рендера.
let keyboardOpen = false;

// Ждать бесконечно нельзя: событие keyboardDidHide теоретически может не
// прийти (нестандартная клавиатура, гонка при сворачивании приложения), и
// тогда переход между экранами не состоялся бы вовсе.
const HIDE_TIMEOUT_MS = 350;

/** Следить за состоянием клавиатуры. Возвращает функцию отписки. */
export function watchMobileKeyboard(): () => void {
  if (!isNativeMobile) return () => {};

  const handles = [
    Keyboard.addListener('keyboardWillShow', () => { keyboardOpen = true; }),
    Keyboard.addListener('keyboardDidHide', () => { keyboardOpen = false; })
  ];

  return () => { handles.forEach((h) => h.then((handle) => handle.remove())); };
}

/**
 * Убрать клавиатуру и дождаться, пока WebView перестроится обратно.
 *
 * Зачем ждать. Когда клавиатура прячется, Android меняет размер WebView. Если
 * это происходит одновременно с CSS-переходом между списком чатов и
 * перепиской, композитор WebView роняет анимацию на полпути: экран застывает
 * в промежуточном положении, поле ввода недоступно, а состояние React при
 * этом уже переключилось — то есть "назад" считает, что мы вернулись, и
 * дальше только сворачивает приложение. Внешне это выглядит как наглухо
 * зависший чат.
 *
 * Поэтому сначала прячем клавиатуру, дожидаемся конца перестроения, и только
 * потом отдаём ход навигации.
 */
export function hideMobileKeyboard(): Promise<void> {
  const active = document.activeElement as HTMLElement | null;
  if (active && typeof active.blur === 'function') active.blur();

  if (!isNativeMobile || !keyboardOpen) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handle.then((h) => h.remove());
      resolve();
    };

    const timer = setTimeout(finish, HIDE_TIMEOUT_MS);
    const handle = Keyboard.addListener('keyboardDidHide', finish);

    Keyboard.hide().catch(() => finish());
  });
}
