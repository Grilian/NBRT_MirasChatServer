import { CustomEmojiMap, preferCustomEmojiToken } from './customEmoji';

// Пресеты статуса профиля — фиксированным набором, а не тем, что пришлёт
// сервер: эмодзи и подпись живут только здесь, в базе хранится лишь ключ
// (см. server/routes/users.js, STATUS_PRESETS), иначе правки текста/эмодзи
// пришлось бы синхронизировать на всех платформах через миграцию данных.
export type StatusPreset = 'vacation' | 'lunch' | 'sick' | 'dayoff';

export const STATUS_PRESETS: Record<StatusPreset, { emoji: string; label: string }> = {
  vacation: { emoji: '🏖️', label: 'В отпуске' },
  lunch: { emoji: '🍽️', label: 'На обеде' },
  sick: { emoji: '🤒', label: 'Болею' },
  dayoff: { emoji: '🛌', label: 'Выходной' },
};

export const STATUS_PRESET_ORDER: StatusPreset[] = ['vacation', 'lunch', 'sick', 'dayoff'];

// На сколько ставится статус. null — бессрочно (как было до появления срока).
// Верхняя граница совпадает с серверной проверкой (STATUS_MAX_DURATION_MS):
// дальше двух недель это уже не статус, а строчка профиля, про которую забудут.
export const STATUS_DURATION_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Без срока' },
  { value: 60 * 60 * 1000, label: 'На час' },
  { value: 4 * 60 * 60 * 1000, label: 'На 4 часа' },
  { value: 24 * 60 * 60 * 1000, label: 'На день' },
  { value: 7 * 24 * 60 * 60 * 1000, label: 'На неделю' },
];

/** Момент снятия статуса из выбранной длительности — то, что уходит на сервер. */
export function statusExpiryFrom(durationMs: number | null): number | null {
  return durationMs === null ? null : Date.now() + durationMs;
}

/**
 * Момент снятия из даты со временем («до 18 августа, 19:00»).
 *
 * Дата задаётся вручную: «через неделю» и «до 19:00» покрывают не всё —
 * отпуск заканчивается конкретным днём, и высчитывать для него длительность
 * человек не должен.
 */
export function statusExpiryOn(dateTime: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(dateTime.trim());
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match;
  const target = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), 0, 0);
  const time = target.getTime();
  // Прошедший момент снял бы статус мгновенно — это точно не то, чего хотели.
  return Number.isFinite(time) && time > Date.now() ? time : null;
}

/**
 * Момент снятия из КОНКРЕТНОГО времени («до 19:00»).
 *
 * Прошедшее время значит завтрашний день: «до 9:00», выставленное вечером, —
 * это утро следующего дня, а не мгновенное снятие статуса.
 */
export function statusExpiryAt(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** Что показать рядом с именем — пресет, свой текст или ничего. */
export function describeStatus(
  preset: string | null | undefined,
  custom: string | null | undefined,
  customEmoji: CustomEmojiMap = {},
): { emoji: string; label: string } | null {
  if (custom && custom.trim()) {
    const parsed = splitStatusIcon(custom);
    if (parsed.emoji && parsed.text) {
      return { emoji: preferCustomEmojiToken(parsed.emoji, customEmoji), label: parsed.text };
    }
    return { emoji: preferCustomEmojiToken('💬', customEmoji), label: custom.trim() };
  }
  if (preset && preset in STATUS_PRESETS) {
    const value = STATUS_PRESETS[preset as StatusPreset];
    return { emoji: preferCustomEmojiToken(value.emoji, customEmoji), label: value.label };
  }
  return null;
}

/** Отделяет shortcode либо первый Unicode-графем от текста своего статуса. */
export function splitStatusIcon(value: string): { emoji: string; text: string } {
  const trimmed = value.trim();
  if (!trimmed) return { emoji: '', text: '' };

  const shortcode = /^(:[a-z0-9_]{2,32}:)(?:\s+|$)/.exec(trimmed);
  if (shortcode) return { emoji: shortcode[1], text: trimmed.slice(shortcode[0].length).trim() };

  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = (Intl as any).Segmenter;
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    const first = Array.from(segmenter.segment(trimmed) as Iterable<{ segment: string }>)[0]?.segment || '';
    if (first && /\p{Extended_Pictographic}/u.test(first)) {
      return { emoji: first, text: trimmed.slice(first.length).trim() };
    }
  }

  const first = Array.from(trimmed)[0];
  if (first && /\p{Extended_Pictographic}/u.test(first)) {
    return { emoji: first, text: trimmed.slice(first.length).replace(/^[️‍]+/, '').trim() };
  }
  return { emoji: '', text: trimmed };
}
