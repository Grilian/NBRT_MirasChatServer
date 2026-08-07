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
export const trimDanglingShortcode = (text: string): string => text.replace(/:[a-z0-9_]{0,32}$/, '');

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
 * Для мест, где картинку не показать вовсе: уведомления ОС и буфер обмена.
 * Код заменяется базовым юникодным эмодзи, а не вырезается — в шторке ОС и в
 * чужом редакторе `:cat:` читался бы как мусор, а пустота теряла бы смысл фразы.
 */
export function toPlainText(text: string, map: CustomEmojiMap): string {
  if (!text) return text;
  return text.replace(SHORTCODE, (whole, name) => (map[name] ? map[name].fallback : whole));
}
