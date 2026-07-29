import { Keyboard } from '@capacitor/keyboard';
import { isNativeMobile } from './mobileNotify';

// Открыта ли сейчас экранная клавиатура. Держим здесь, а не в состоянии React:
// значение нужно синхронно в момент навигации, до всякого рендера.
//
// Это защёлка, и раньше снять её могло только событие keyboardDidHide. Android
// его не гарантирует: клавиатуру закрывают жестом, системой при перестроении
// WebView или уходом приложения в фон — и тогда защёлка навсегда оставалась в
// "true". Поэтому слушаем ещё и keyboardWillHide, а главное — сбрасываем её
// сами в hideMobileKeyboard, не дожидаясь подтверждения от нативной части.
let keyboardOpen = false;

/** Следить за состоянием клавиатуры. Возвращает функцию отписки. */
export function watchMobileKeyboard(): () => void {
  if (!isNativeMobile) return () => {};

  const handles = [
    Keyboard.addListener('keyboardWillShow', () => { keyboardOpen = true; }),
    Keyboard.addListener('keyboardDidShow', () => { keyboardOpen = true; }),
    Keyboard.addListener('keyboardWillHide', () => { keyboardOpen = false; }),
    Keyboard.addListener('keyboardDidHide', () => { keyboardOpen = false; })
  ];

  return () => {
    handles.forEach((h) => h.then((handle) => handle.remove()).catch(() => {}));
  };
}

/**
 * Подписка на появление клавиатуры (Android: adjustResize уменьшает высоту
 * самого WebView — это единственная причина звать колбэк, поэтому
 * достаточно keyboardDidShow, без Will-варианта). Возвращает функцию отписки.
 *
 * Зачем это отдельно от watchMobileKeyboard: тому нужен только факт
 * «открыта/закрыта» для защёлки, а здесь вызывающему (ChatWindow) нужно
 * реагировать именно на сам момент появления — перепрокручивать ленту вниз,
 * которую перестроение WebView иначе оставляет упёртой в старый scrollTop.
 */
export function onKeyboardShow(callback: () => void): () => void {
  if (!isNativeMobile) return () => {};

  const listenerPromise = Keyboard.addListener('keyboardDidShow', () => callback());
  return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
}

/**
 * Убрать экранную клавиатуру. Ничего не возвращает и никогда не бросает.
 *
 * Раньше функция возвращала промис («клавиатура убрана, WebView перестроился»),
 * и вся навигация переключала экраны только внутри его .then(). Это и было
 * причиной залипания на открытом чате: промис создавался вокруг вызовов
 * нативного моста (Keyboard.hide / Keyboard.addListener), а страховочный таймаут
 * жил внутри него же. Стоило мосту ответить отказом — исключение из тела
 * промиса превращалось в reject, .then() не выполнялся никогда, и разом умирали
 * все точки навигации: рельс разделов, кнопка «назад» в шапке переписки и
 * аппаратная «назад» (она вызывает тот же leaveConversation). А в режиме
 * переписки рельс скрыт, так что выйти становилось нечем — ровно то, что
 * чинилось только полным перезапуском приложения.
 *
 * Теперь навигация от нативного моста не зависит вовсе: экран переключается
 * синхронно, а клавиатура просто получает команду закрыться в том же кадре.
 *
 * Возвращает, была ли клавиатура открыта. Само перестроение WebView под
 * уезжающую клавиатуру никуда не делось и по-прежнему способно испортить
 * CSS-переход между панелями — но это повод отключить анимацию на этот раз
 * (см. is-no-pane-anim в Chat.tsx), а не откладывать переход.
 */
export function hideMobileKeyboard(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && typeof active.blur === 'function') active.blur();

  if (!isNativeMobile || !keyboardOpen) return false;

  // Считаем клавиатуру закрытой сразу: подтверждения событием можно не
  // дождаться, а зависший в "true" флаг гнал бы сюда каждый следующий переход.
  keyboardOpen = false;

  try {
    Keyboard.hide().catch(() => {});
  } catch {
    // Плагин недоступен (веб-сборка, старый нативный слой) — не наша забота:
    // навигация к этому моменту уже произошла.
  }

  return true;
}
