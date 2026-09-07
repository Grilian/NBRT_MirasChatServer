import { registerPlugin } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { isNativeMobile } from './mobileNotify';

interface ChatKeyboardPlugin {
  setOverlay(options: { active: boolean }): Promise<{ navigationBarHeight?: number }>;
}

// @capacitor/keyboard умеет менять resize mode только на iOS. На Android его
// setResizeMode() возвращает unimplemented, поэтому режим окна переключает
// небольшой локальный плагин из mobile/android.
const ChatKeyboard = registerPlugin<ChatKeyboardPlugin>('ChatKeyboard');

// Открыта ли сейчас экранная клавиатура. Держим здесь, а не в состоянии React:
// значение нужно синхронно в момент навигации, до всякого рендера.
//
// Это защёлка, и раньше снять её могло только событие keyboardDidHide. Android
// его не гарантирует: клавиатуру закрывают жестом, системой при перестроении
// WebView или уходом приложения в фон — и тогда защёлка навсегда оставалась в
// "true". Поэтому слушаем ещё и keyboardWillHide, а главное — сбрасываем её
// сами в hideMobileKeyboard, не дожидаясь подтверждения от нативной части.
let keyboardOpen = false;
let navigationBarHeight = 0;
// v2 хранит видимую высоту IME без системной navigation bar. Старое значение включало её
// и как раз оставляло над Gboard лишнюю полосу высотой с нижнюю системную панель.
const KEYBOARD_HEIGHT_STORAGE_KEY = 'miras-mobile-keyboard-height-v2';
function readStoredKeyboardHeight(): number {
  if (typeof window === 'undefined') return 0;
  try {
    return Number(window.localStorage.getItem(KEYBOARD_HEIGHT_STORAGE_KEY));
  } catch {
    return 0;
  }
}
const storedKeyboardHeight = readStoredKeyboardHeight();
let lastKeyboardHeight = storedKeyboardHeight >= 120 ? storedKeyboardHeight : 300;
let closeInputSurface: (() => boolean) | null = null;
// Ветка монтирует второй MessageInput поверх основного, а редактор опроса —
// обычные поля поверх обоих. Прямые setOverlay(true/false) от каждого экрана
// конфликтовали: размонтирование одного composer выключало overlay у другого.
// Счётчики превращают режим окна в совместно используемый ресурс.
let chatOverlayOwners = 0;
let standardResizeOwners = 0;

function visibleKeyboardHeight(nativeHeight = 0): number {
  return Math.max(0, Math.round(nativeHeight - navigationBarHeight));
}

function rememberKeyboardHeight(nativeHeight = 0) {
  const height = visibleKeyboardHeight(nativeHeight);
  if (height < 120) return;
  lastKeyboardHeight = height;
  try {
    window.localStorage.setItem(KEYBOARD_HEIGHT_STORAGE_KEY, String(lastKeyboardHeight));
  } catch {
    // localStorage может быть недоступен в ограниченном WebView — текущее
    // значение всё равно останется правильным до перезапуска приложения.
  }
}

/** Следить за состоянием клавиатуры. Возвращает функцию отписки. */
export function watchMobileKeyboard(): () => void {
  if (!isNativeMobile) return () => {};

  const handles = [
    Keyboard.addListener('keyboardWillShow', (info) => {
      keyboardOpen = true;
      rememberKeyboardHeight(info.keyboardHeight);
    }),
    Keyboard.addListener('keyboardDidShow', (info) => {
      keyboardOpen = true;
      rememberKeyboardHeight(info.keyboardHeight);
    }),
    Keyboard.addListener('keyboardWillHide', () => { keyboardOpen = false; }),
    Keyboard.addListener('keyboardDidHide', () => {
      keyboardOpen = false;
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
export function onKeyboardWillShow(callback: (height: number) => void): () => void {
  if (!isNativeMobile) return () => {};
  const listenerPromise = Keyboard.addListener('keyboardWillShow', (info) => {
    rememberKeyboardHeight(info.keyboardHeight);
    callback(visibleKeyboardHeight(info.keyboardHeight));
  });
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
export function onKeyboardShow(callback: (height: number) => void): () => void {
  if (!isNativeMobile) return () => {};

  const listenerPromise = Keyboard.addListener('keyboardDidShow', (info) => callback(visibleKeyboardHeight(info.keyboardHeight)));
  return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
}

/** Подписаться на полное скрытие Android IME. */
export function onKeyboardHide(callback: () => void): () => void {
  if (!isNativeMobile) return () => {};
  const listenerPromise = Keyboard.addListener('keyboardDidHide', callback);
  return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
}

/**
 * MessageInput регистрирует здесь закрытие общей нижней поверхности. Это
 * позволяет аппаратной кнопке «Назад» закрыть emoji-панель до навигации.
 */
export function registerMobileInputSurfaceCloser(closer: () => boolean): () => void {
  closeInputSurface = closer;
  return () => { if (closeInputSurface === closer) closeInputSurface = null; };
}

/** Закрыть нижнюю поверхность, если она сейчас открыта. */
export function closeMobileInputSurface(): boolean {
  return closeInputSurface?.() || false;
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

  if (!isNativeMobile) return false;
  const wasOpen = keyboardOpen;

  // Считаем клавиатуру закрытой сразу: подтверждения событием можно не
  // дождаться, а зависший в "true" флаг гнал бы сюда каждый следующий переход.
  keyboardOpen = false;

  try {
    Keyboard.hide().catch(() => {});
  } catch {
    // Плагин недоступен (веб-сборка, старый нативный слой) — не наша забота:
    // навигация к этому моменту уже произошла.
  }

  return wasOpen;
}

/** Гарантированно запросить Android IME для уже сфокусированного поля. */
export function showMobileKeyboard(): void {
  if (!isNativeMobile) return;
  try {
    Keyboard.show().catch(() => {});
  } catch {
    // Старый нативный слой без Keyboard.show: штатный focus всё ещё остаётся основным запросом.
  }
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
function applyKeyboardResizeMode(): void {
  if (!isNativeMobile) return;
  const active = chatOverlayOwners > 0 && standardResizeOwners === 0;
  try {
    ChatKeyboard.setOverlay({ active }).then((result) => {
      if (typeof result.navigationBarHeight === 'number') {
        navigationBarHeight = Math.max(0, Math.round(result.navigationBarHeight));
      }
    }).catch(() => {});
  } catch {
    // Плагин недоступен — не наша забота, экран продолжает жить как есть.
  }
}

/** Удерживать overlay-режим, пока смонтирован composer переписки. */
export function acquireChatKeyboardResizeMode(): () => void {
  if (!isNativeMobile) return () => {};
  chatOverlayOwners += 1;
  applyKeyboardResizeMode();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatOverlayOwners = Math.max(0, chatOverlayOwners - 1);
    applyKeyboardResizeMode();
  };
}

/**
 * Модальные формы с обычными input/textarea должны использовать adjustResize,
 * даже если под ними остаётся смонтированная переписка.
 */
export function acquireStandardKeyboardResizeMode(): () => void {
  if (!isNativeMobile) return () => {};
  standardResizeOwners += 1;
  applyKeyboardResizeMode();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    standardResizeOwners = Math.max(0, standardResizeOwners - 1);
    applyKeyboardResizeMode();
  };
}

/** Повторно применить выбранный владельцами режим после resume/rotation. */
export function refreshMobileKeyboardResizeMode(): void {
  applyKeyboardResizeMode();
}
