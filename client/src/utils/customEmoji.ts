import React from 'react';
import { resolveUploadUrl } from './uploads';

/** Кастомный смайлик-картинка. Имя уникально глобально — по нему и ищем. */
export interface CustomEmoji {
  id: number;
  name: string;
  file_path: string;
  /** Базовый юникодный эмодзи — для мест, где картинку не показать. */
  fallback?: string | null;
}

/** name → чем его показывать. Плоская карта: в тексте пака нет, только :name:. */
export type CustomEmojiMap = Record<string, { filePath: string; animatedPath?: string | null; fallback: string }>;

// Подставляется, когда базовый эмодзи у смайлика не задан. Одно место на весь
// клиент — старые записи в БД бэкфиллить не нужно.
export const DEFAULT_EMOJI_FALLBACK = '🙂';

export const buildEmojiMap = (
  items: { name: string; file_path: string; animated_path?: string | null; fallback?: string | null }[],
): CustomEmojiMap => {
  const map: CustomEmojiMap = {};
  for (const item of items) {
    if (!item?.name || !item.file_path) continue;
    map[item.name] = {
      filePath: item.file_path,
      animatedPath: item.animated_path || null,
      fallback: item.fallback || DEFAULT_EMOJI_FALLBACK,
    };
  }
  return map;
};

/**
 * Показывать ли анимированные версии. Читается на каждой отрисовке из общей
 * настройки устройства, а не прокидывается пропсом через всю переписку: смайлики
 * рисуются в десятке разных мест (лента, цитаты, превью, реакции), и тащить
 * флаг в каждое — верный способ забыть его в половине из них.
 */
let animationEnabled = true;
export const setEmojiAnimationEnabled = (enabled: boolean): void => { animationEnabled = enabled; };
export const isEmojiAnimationEnabled = (): boolean => animationEnabled;

// Тот же формат, что на сервере (routes/emoji.js): только латиница нижнего
// регистра, цифры и подчёркивание, от двух символов. Специально узкий, чтобы
// не цеплять ни смайлики-двоеточия (":D"), ни порты в ссылках ("host:8080").
const SHORTCODE = /:([a-z0-9_]{2,32}):/g;

/**
 * Хвост оборванного кода в конце строки. Обрезка текста по длине не должна
 * оставлять на виду огрызок вида ":cat" — он уже не станет картинкой.
 */
export const trimDanglingShortcode = (text: string): string => text.replace(/:[a-z0-9_]{1,32}$/, '');

/** Есть ли в тексте хоть один ИЗВЕСТНЫЙ код — чтобы зря не резать строку. */
export const hasCustomEmoji = (text: string, map: CustomEmojiMap): boolean => {
  if (!text) return false;
  SHORTCODE.lastIndex = 0;
  let m = SHORTCODE.exec(text);
  while (m) {
    if (map[m[1]]) return true;
    m = SHORTCODE.exec(text);
  }
  return false;
};

/**
 * Текст с картинками вместо :name:. Возвращает массив узлов, а не HTML:
 * вставлять разметку строкой в сообщение нельзя — это прямая дорога к
 * инъекции чужого кода в чужой браузер.
 *
 * Неизвестные коды остаются текстом как есть. Так и задумано: подменять их
 * пустотой значило бы менять содержимое чужого сообщения. В норме сюда они не
 * попадают вовсе — каталог отрисовки (GET /emoji/catalog) отдаёт все смайлики,
 * которые когда-либо существовали, включая убранные и из выключенных паков.
 */
export function renderTextWithEmoji(
  text: string,
  map: CustomEmojiMap,
  keyPrefix = 'e',
): React.ReactNode {
  if (!text || !hasCustomEmoji(text, map)) return text;

  const nodes: React.ReactNode[] = [];
  let last = 0;
  let index = 0;
  SHORTCODE.lastIndex = 0;

  let match = SHORTCODE.exec(text);
  while (match) {
    const item = map[match[1]];
    if (item) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      nodes.push(React.createElement(CustomEmojiImage, {
        key: `${keyPrefix}-${index}`,
        // Анимированная версия — только в переписке и только если человек её
        // не выключил; статичная есть всегда и служит запасным вариантом.
        filePath: (animationEnabled && item.animatedPath) || item.filePath,
        fallback: item.fallback,
      }));
      index += 1;
      last = match.index + match[0].length;
    }
    match = SHORTCODE.exec(text);
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// URL распознаём только с явной схемой http(s) либо с www. — произвольные
// доменные имена текстом не превращаем в ссылки. E-mail подсвечивается отдельно,
// но намеренно остаётся span: приложение не должно открывать почтовый клиент.
const MESSAGE_TOKEN = /((?:https?:\/\/|www\.)[^\s<]+|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const SIMPLE_EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function trimUrlTail(value: string): { value: string; tail: string } {
  let end = value.length;
  while (end > 0 && /[.,!?;:]/.test(value[end - 1])) end -= 1;

  // Закрывающую скобку сохраняем, если внутри URL есть соответствующая
  // открывающая. Иначе это пунктуация окружающего предложения.
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (end > 0 && pairs[value[end - 1]]) {
    const close = value[end - 1];
    const open = pairs[close];
    const body = value.slice(0, end);
    const opens = body.split(open).length - 1;
    const closes = body.split(close).length - 1;
    if (opens >= closes) break;
    end -= 1;
  }

  return { value: value.slice(0, end), tail: value.slice(end) };
}

function renderMessagePlainText(text: string, keyPrefix: string, nextKey: () => number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  MESSAGE_TOKEN.lastIndex = 0;
  let match = MESSAGE_TOKEN.exec(text);

  while (match) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (SIMPLE_EMAIL.test(token)) {
      nodes.push(React.createElement('span', {
        key: `${keyPrefix}-mail-${nextKey()}`,
        className: 'message-email',
      }, token));
    } else {
      const { value, tail } = trimUrlTail(token);
      if (value) {
        nodes.push(React.createElement('a', {
          key: `${keyPrefix}-link-${nextKey()}`,
          className: 'message-link',
          href: /^www\./i.test(value) ? `https://${value}` : value,
          target: '_blank',
          rel: 'noopener noreferrer',
          onClick: (event: React.MouseEvent) => event.stopPropagation(),
        }, value));
      }
      if (tail) nodes.push(tail);
    }
    last = match.index + token.length;
    match = MESSAGE_TOKEN.exec(text);
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Текст сообщения с кастомными emoji, кликабельными URL и некликабельной почтой. */
export function renderMessageText(
  text: string,
  map: CustomEmojiMap,
  keyPrefix = 'm',
): React.ReactNode {
  if (!text) return text;

  const nodes: React.ReactNode[] = [];
  let last = 0;
  let keyIndex = 0;
  const nextKey = () => keyIndex++;
  SHORTCODE.lastIndex = 0;
  let match = SHORTCODE.exec(text);

  while (match) {
    const item = map[match[1]];
    if (item) {
      if (match.index > last) {
        nodes.push(...renderMessagePlainText(text.slice(last, match.index), keyPrefix, nextKey));
      }
      nodes.push(React.createElement(CustomEmojiImage, {
        key: `${keyPrefix}-emoji-${nextKey()}`,
        // Основной рендер текста сообщения обязан использовать ту же логику,
        // что превью/цитаты: при включённой анимации берём animatedPath.
        // Раньше здесь всегда передавался filePath, поэтому в списке чатов
        // смайлик двигался, а внутри самой переписки оставался статичным.
        filePath: (animationEnabled && item.animatedPath) || item.filePath,
        fallback: item.fallback,
      }));
      last = match.index + match[0].length;
    }
    match = SHORTCODE.exec(text);
  }

  if (last < text.length) nodes.push(...renderMessagePlainText(text.slice(last), keyPrefix, nextKey));
  return nodes;
}

// Какие картинки уже приезжали за эту сессию. Нужен, чтобы уже показанный
// смайлик не моргал заглушкой каждый раз, когда сообщение перерисовывается:
// из кэша браузера картинка готова сразу, и лишнее промежуточное состояние
// давало бы мелькание в спокойной обстановке ради выигрыша на первой загрузке.
const loadedEmojiPaths = new Set<string>();

/**
 * Картинка с подстановкой базового эмодзи в двух случаях: файла на диске уже
 * нет (иначе посреди фразы была бы иконка «сломанное изображение») и файл ещё
 * не приехал. Второе — ради слабой связи: анимированный webp весит заметно
 * больше строки текста, и без заглушки в предложении зияли бы дыры, пока он
 * грузится. Дыр не будет и по размеру: `.custom-emoji-fallback` занимает то же
 * место, что и картинка, поэтому подмена не двигает текст.
 */
const CustomEmojiImage: React.FC<{ filePath: string; fallback: string }> = ({ filePath, fallback }) => {
  const [state, setState] = React.useState<'loading' | 'ready' | 'broken'>(
    () => (loadedEmojiPaths.has(filePath) ? 'ready' : 'loading')
  );

  if (state === 'broken') return React.createElement('span', { className: 'custom-emoji-fallback' }, fallback);

  const image = React.createElement('img', {
    className: 'custom-emoji' + (state === 'loading' ? ' is-loading' : ''),
    src: resolveUploadUrl(filePath) || '',
    alt: fallback,
    draggable: false,
    decoding: 'async',
    onLoad: () => { loadedEmojiPaths.add(filePath); setState('ready'); },
    onError: () => setState('broken'),
  });

  if (state === 'ready') return image;
  // Заглушка и картинка живут рядом: скрытая картинка всё равно загружается,
  // поэтому подменять src или монтировать её позже не нужно.
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('span', { className: 'custom-emoji-fallback is-placeholder', 'aria-hidden': true }, fallback),
    image,
  );
};

/**
 * Готовый DOM-узел смайлика для поля ввода. В отличие от React-версии выше,
 * тут нужен настоящий элемент: поле ввода — contentEditable, React его
 * содержимое не рисует (иначе курсор прыгал бы на каждое нажатие).
 *
 * `contentEditable=false` делает смайлик неделимым: курсор не заходит внутрь,
 * а браузер удаляет его одним движением, а не по символу.
 */
export function createEmojiNode(name: string, filePath: string, fallback: string): HTMLElement {
  const img = document.createElement('img');
  img.className = 'custom-emoji';
  img.src = resolveUploadUrl(filePath) || '';
  img.alt = fallback;
  img.draggable = false;
  img.contentEditable = 'false';
  // Имя ищется при обратной сборке текста — путь к файлу для этого не годится,
  // он может смениться при замене картинки под тем же кодом.
  img.dataset.emojiName = name;
  img.dataset.emojiFallback = fallback;
  img.onerror = () => {
    const span = document.createElement('span');
    span.className = 'custom-emoji-fallback';
    span.contentEditable = 'false';
    span.dataset.emojiName = name;
    span.dataset.emojiFallback = fallback;
    span.textContent = fallback;
    img.replaceWith(span);
  };
  return img;
}

/** Узнаётся по data-атрибуту, а не по классу: класс — дело оформления. */
export const isEmojiNode = (node: Node | null | undefined): node is HTMLElement =>
  !!node && node.nodeType === Node.ELEMENT_NODE && !!(node as HTMLElement).dataset?.emojiName;

/**
 * Текст с кодами → готовые узлы для вставки в поле ввода. Тот же разбор, что и
 * в renderTextWithEmoji, но на выходе DOM: используется при открытии правки
 * сообщения и при вставке из буфера.
 */
export function textToFragment(text: string, map: CustomEmojiMap): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  let last = 0;
  SHORTCODE.lastIndex = 0;

  let match = SHORTCODE.exec(text);
  while (match) {
    const item = map[match[1]];
    if (item) {
      if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      fragment.appendChild(createEmojiNode(match[1], item.filePath, item.fallback));
      last = match.index + match[0].length;
    }
    match = SHORTCODE.exec(text);
  }

  if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
  return fragment;
}

/**
 * Поле ввода → текст для отправки. Обход рекурсивный, хотя своей разметки мы не
 * создаём (перенос строки вставляется literal '\n', а не <br>/<div>): браузеры
 * всё равно норовят завернуть содержимое в свои узлы при вставке и автозамене,
 * и плоский проход молча потерял бы такой текст.
 */
export function domToText(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data;
      return;
    }
    if (isEmojiNode(node)) {
      out += `:${node.dataset.emojiName}:`;
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.tagName === 'BR') {
        out += '\n';
        return;
      }
      // Блочный узел, пришедший из вставки, — это начало новой строки.
      if (out && !out.endsWith('\n') && BLOCK_TAGS.has(el.tagName)) out += '\n';
      el.childNodes.forEach(walk);
    }
  };
  root.childNodes.forEach(walk);
  return out;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * Для мест, где картинку не показать вовсе: уведомления ОС и буфер обмена.
 * Код заменяется базовым юникодным эмодзи, а не вырезается — в шторке ОС и в
 * чужом редакторе `:cat:` читался бы как мусор, а пустота теряла бы смысл фразы.
 */
export function toPlainText(text: string, map: CustomEmojiMap): string {
  if (!text) return text;
  return text.replace(SHORTCODE, (whole, name) => (map[name] ? map[name].fallback : whole));
}
