import React from 'react';
import { resolveUploadUrl } from './uploads';

/** Кастомный смайлик-картинка. Имя уникально глобально — по нему и ищем. */
export interface CustomEmoji {
  id: number;
  name: string;
  file_path: string;
}

/** name → путь к картинке. Плоская карта: в тексте пака нет, только :name:. */
export type CustomEmojiMap = Record<string, string>;

export const buildEmojiMap = (packs: { custom?: CustomEmoji[] }[]): CustomEmojiMap => {
  const map: CustomEmojiMap = {};
  for (const pack of packs) {
    for (const item of pack.custom || []) map[item.name] = item.file_path;
  }
  return map;
};

// Тот же формат, что на сервере (routes/emoji.js): только латиница нижнего
// регистра, цифры и подчёркивание, от двух символов. Специально узкий, чтобы
// не цеплять ни смайлики-двоеточия (":D"), ни порты в ссылках ("host:8080").
const SHORTCODE = /:([a-z0-9_]{2,32}):/g;

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
 * Неизвестные коды остаются текстом как есть. Так и задумано: пак могли
 * выключить или смайлик удалить, и подменять их пустотой значило бы менять
 * содержимое чужого сообщения.
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
    const filePath = map[match[1]];
    if (filePath) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      nodes.push(React.createElement('img', {
        key: `${keyPrefix}-${index}`,
        className: 'custom-emoji',
        src: resolveUploadUrl(filePath) || '',
        alt: `:${match[1]}:`,
        title: `:${match[1]}:`,
        draggable: false,
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
 * Для мест, где картинку не показать вовсе — системные уведомления ОС.
 * Коды вырезаются, а не остаются как `:cat:`: человек в шторке увидел бы
 * непонятный текст с двоеточиями. Если от сообщения ничего не осталось,
 * вызывающий подставит свою подпись.
 */
export function stripCustomEmoji(text: string, map: CustomEmojiMap): string {
  if (!text) return text;
  return text.replace(SHORTCODE, (whole, name) => (map[name] ? '' : whole)).replace(/\s{2,}/g, ' ').trim();
}
