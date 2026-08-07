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
export type CustomEmojiMap = Record<string, { filePath: string; fallback: string }>;

// Подставляется, когда базовый эмодзи у смайлика не задан. Одно место на весь
// клиент — старые записи в БД бэкфиллить не нужно.
export const DEFAULT_EMOJI_FALLBACK = '🙂';

export const buildEmojiMap = (
  items: { name: string; file_path: string; fallback?: string | null }[],
): CustomEmojiMap => {
  const map: CustomEmojiMap = {};
  for (const item of items) {
    if (!item?.name || !item.file_path) continue;
    map[item.name] = { filePath: item.file_path, fallback: item.fallback || DEFAULT_EMOJI_FALLBACK };
  }
  return map;
};

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
        filePath: item.filePath,
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

/**
 * Картинка с подстановкой базового эмодзи, если файла на диске уже нет. Без
 * этого пропавший файл давал иконку «сломанное изображение» посреди фразы.
 */
const CustomEmojiImage: React.FC<{ filePath: string; fallback: string }> = ({ filePath, fallback }) => {
  const [broken, setBroken] = React.useState(false);
  if (broken) return React.createElement('span', { className: 'custom-emoji-fallback' }, fallback);
  return React.createElement('img', {
    className: 'custom-emoji',
    src: resolveUploadUrl(filePath) || '',
    alt: fallback,
    draggable: false,
    onError: () => setBroken(true),
  });
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
