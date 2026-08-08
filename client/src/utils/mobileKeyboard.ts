import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
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
let lastKeyboardHeight = 300;

// Высота layout viewport в CSS-пикселях, когда клавиатура закрыта.
// Для emoji-панели это надёжнее нативного keyboardHeight: на Android
// встречаются устройства/клавиатуры, где плагин сообщает неполную высоту.
let expandedViewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

function currentViewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  // Панель живёт в CSS-layout WebView, поэтому измеряем именно ту высоту,
  // которой реально располагает страница после adjustResize.
  return document.documentElement?.clientHeight || window.innerHeight || 0;
}

function rememberKeyboardHeight(nativeHeight = 0) {
  const now = currentViewportHeight();
  const viewportDelta = expandedViewportHeight > now ? expandedViewportHeight - now : 0;

  // Разница viewport совпадает с реальным количеством CSS-пикселей, которое
  // Android отнял у приложения. Нативное значение оставляем только fallback.
  const measured = viewportDelta >= 120 ? viewportDelta : nativeHeight;
  if (measured >= 120) lastKeyboardHeight = measured;
}

/** Следить за состоянием клавиатуры. Возвращает функцию отписки. */
export function watchMobileKeyboard(): () => void {
  if (!isNativeMobile) return () => {};

  const handles = [
    Keyboard.addListener('keyboardWillShow', (info) => {
      keyboardOpen = true;
      // На WILL viewport может быть ещё старого размера, поэтому это лишь fallback.
      if (info.keyboardHeight >= 120) lastKeyboardHeight = info.keyboardHeight;
    }),
    Keyboard.addListener('keyboardDidShow', (info) => {
      keyboardOpen = true;
      rememberKeyboardHeight(info.keyboardHeight);
    }),
    Keyboard.addListener('keyboardWillHide', () => { keyboardOpen = false; }),
    Keyboard.addListener('keyboardDidHide', () => {
      keyboardOpen = false;
      // После полного скрытия это новая эталонная высота WebView (в том числе
      // после поворота экрана или изменения системных inset'ов).
      const h = currentViewportHeight();
      if (h > 0) expandedViewportHeight = h;
    })
  ];

  return () => {
    handles.forEach((h) => h.then((handle) => handle.remove()).catch(() => {}));
  };
}



/** Текущее синхронное состояние системной клавиатуры. */
export function isMobileKeyboardOpen(): boolean {
  return isNativeMobile && keyboardOpen;
}

/** Событие непосредственно перед изменением Android viewport при показе клавиатуры. */
export function onKeyboardWillShow(callback: () => void): () => void {
  if (!isNativeMobile) return () => {};
  const listenerPromise = Keyboard.addListener('keyboardWillShow', () => callback());
  return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
}

/** Событие непосредственно перед изменением Android viewport при скрытии клавиатуры. */
export function onKeyboardWillHide(callback: () => void): () => void {
  if (!isNativeMobile) return () => {};
  const listenerPromise = Keyboard.addListener('keyboardWillHide', () => callback());
  return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
}

/** Последняя известная высота системной клавиатуры в CSS-пикселях.
 * Нужна панели смайликов, чтобы занять примерно то же место и не дёргать
 * переписку при переключении «клавиатура ↔ смайлики». */
export function getLastMobileKeyboardHeight(): number {
  // Не ограничиваем сверху: современные клавиатуры с рядом подсказок,
  // панелью инструментов или крупным масштабом легко выше прежних 420px.
  return Math.max(180, Math.round(lastKeyboardHeight || 300));
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

/**
 * Включить/выключить нативный ресайз WebView под клавиатуру. Настройка на
 * всё приложение целиком, а не на конкретный экран — поэтому дёргаем её
 * точечно, только пока открыта переписка (см. MessageInput), и возвращаем
 * обратно при выходе. На остальных экранах (логин, диалоги, панели) ресайз
 * остаётся штатным — их поля по-прежнему сами уезжают от клавиатуры.
 *
 * Ничего не ждём и не бросаем — тот же принцип, что и в hideMobileKeyboard:
 * нативный мост может быть недоступен, рендер от него зависеть не должен.
 */
export function setChatKeyboardResizeMode(active: boolean): void {
  if (!isNativeMobile) return;
  try {
    Keyboard.setResizeMode({ mode: active ? KeyboardResize.None : KeyboardResize.Native }).catch(() => {});
  } catch {
    // Плагин недоступен — не наша забота, экран продолжает жить как есть.
  }
}
