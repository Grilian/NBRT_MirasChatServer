import { DayKey, instantOf, minutesOf, dayKeyOf } from './dates';
import { CalendarOccurrence } from './types';

/** Вхождения, попадающие в этот календарный день (событие может занимать несколько). */
export function occurrencesOn(list: CalendarOccurrence[], day: DayKey): CalendarOccurrence[] {
  const dayStart = instantOf(day, 0);
  const dayEnd = instantOf(day, 24 * 60);
  return list.filter((item) => item.starts_at < dayEnd && item.ends_at > dayStart);
}

/**
 * Порядок внутри дня: сначала весь день, потом задачи и события по времени.
 *
 * Событие на весь день сверху не по важности, а по смыслу: у него нет позиции
 * во времени, и вклинившись между «10:00» и «14:00» оно ломало бы чтение
 * колонки как ленты времени.
 */
export function sortForDay(list: CalendarOccurrence[]): CalendarOccurrence[] {
  return [...list].sort((a, b) => {
    if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
    return a.starts_at - b.starts_at;
  });
}

export interface PositionedOccurrence {
  occurrence: CalendarOccurrence;
  /** Доли суток: 0 — полночь, 1 — следующая полночь. */
  top: number;
  height: number;
  /** Раскладка пересекающихся: колонка и сколько их всего в грозди. */
  lane: number;
  lanes: number;
}

// Минимальная высота вхождения в сетке — иначе пятиминутная встреча
// превращается в нечитаемую полоску без названия.
const MIN_FRACTION = 20 / (24 * 60);

/**
 * Раскладка событий одного дня в сетке времени.
 *
 * Пересекающиеся встречи расставляются по колонкам: события сортируются по
 * началу и каждое занимает первую колонку, освободившуюся к его началу.
 * Ширина считается по грозди — набору событий, связанных пересечениями, — а не
 * по всему дню: иначе одна пара наложившихся встреч сжимала бы вдвое весь день.
 */
export function positionDay(list: CalendarOccurrence[], day: DayKey): PositionedOccurrence[] {
  const dayStart = instantOf(day, 0);
  const dayEnd = instantOf(day, 24 * 60);
  const dayLength = dayEnd - dayStart;

  const timed = list
    .filter((item) => !item.all_day)
    .sort((a, b) => a.starts_at - b.starts_at || b.ends_at - a.ends_at);

  const positioned: PositionedOccurrence[] = timed.map((occurrence) => {
    const start = Math.max(occurrence.starts_at, dayStart);
    const end = Math.min(Math.max(occurrence.ends_at, start + 1), dayEnd);
    return {
      occurrence,
      top: (start - dayStart) / dayLength,
      height: Math.max((end - start) / dayLength, MIN_FRACTION),
      lane: 0,
      lanes: 1,
    };
  });

  // Гроздь — непрерывная цепочка пересечений. Пока новое событие начинается
  // раньше, чем закончилось самое позднее в грозди, оно относится к ней же.
  let clusterStart = 0;
  let clusterEnd = -Infinity;
  const laneEnds: number[] = [];

  const closeCluster = (until: number) => {
    const lanes = laneEnds.length || 1;
    for (let i = clusterStart; i < until; i += 1) positioned[i].lanes = lanes;
    laneEnds.length = 0;
    clusterStart = until;
    clusterEnd = -Infinity;
  };

  positioned.forEach((item, index) => {
    const start = item.occurrence.starts_at;
    const end = Math.max(item.occurrence.ends_at, start + 1);

    if (start >= clusterEnd) closeCluster(index);

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }

    item.lane = lane;
    clusterEnd = Math.max(clusterEnd, end);
  });

  closeCluster(positioned.length);
  return positioned;
}

/** Позиция линии «сейчас» в долях суток; null — если день не сегодняшний. */
export function nowFraction(day: DayKey): number | null {
  const now = Date.now();
  if (dayKeyOf(now) !== day) return null;
  return minutesOf(now) / (24 * 60);
}
