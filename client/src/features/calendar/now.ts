import { CalendarOccurrence } from './types';

/**
 * Что идёт прямо сейчас и что будет следующим.
 *
 * Вынесено отдельной чистой функцией, потому что ответ нужен в двух местах
 * сразу — полосой в шапке календаря на широком экране и подписью «идёт
 * сейчас» на карточке в ленте, — и две копии этого расчёта разъехались бы на
 * первой же правке (ровно так уже расходились правила видимости календаря).
 *
 * Событие «на весь день» текущим НЕ считается. Формально оно идёт все сутки, и
 * полоса «сейчас: книжная выставка, до 23:59» висела бы весь день, вытесняя
 * то, к чему действительно надо идти через десять минут. Смысл ответа —
 * «чем ты занят прямо в эту минуту», а выставка длиной в день на этот вопрос
 * не отвечает.
 */
export interface NowState {
  /** Идёт прямо сейчас. Ближайшее к концу — оно освободится первым. */
  current: CalendarOccurrence | null;
  /** Ближайшее из того, что ещё не началось. */
  next: CalendarOccurrence | null;
}

export function resolveNow(occurrences: CalendarOccurrence[], now: number): NowState {
  let current: CalendarOccurrence | null = null;
  let next: CalendarOccurrence | null = null;

  for (const item of occurrences) {
    if (item.all_day) continue;
    if (item.starts_at <= now && item.ends_at > now) {
      // Пересекающихся встреч не бывает «правильных», но бывают реальные.
      // Показываем ту, что закончится раньше: это ближайшая точка, где у
      // человека что-то изменится.
      if (!current || item.ends_at < current.ends_at) current = item;
    } else if (item.starts_at > now) {
      if (!next || item.starts_at < next.starts_at) next = item;
    }
  }

  return { current, next };
}

/**
 * Идёт ли отрезок прямо сейчас.
 *
 * Границы передаются числами, а не объектом: то же самое спрашивает «Главная»,
 * а у неё своя форма события (`startAt`/`endAt`). Правило «что считается
 * текущим» обязано быть одно на всех — иначе полоса в календаре и подпись на
 * «Главной» однажды разойдутся в показаниях.
 */
export function isRunningAt(startAt: number, endAt: number, allDay: boolean, now: number): boolean {
  return !allDay && startAt <= now && endAt > now;
}

/** Идёт ли это вхождение прямо сейчас. */
export function isRunning(occurrence: CalendarOccurrence, now: number): boolean {
  return isRunningAt(occurrence.starts_at, occurrence.ends_at, !!occurrence.all_day, now);
}
