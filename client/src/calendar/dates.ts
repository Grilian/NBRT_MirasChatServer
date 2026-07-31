import { moscowOffsetMs } from '../utils/time';

// Календарь считает всё в московском времени, независимо от зоны устройства —
// как и остальное приложение. Для сетки это критичнее, чем для сообщений:
// «вторник» должен быть одним и тем же вторником у всех, иначе у человека в
// другой зоне событие уедет в соседнюю клетку.
//
// Основная валюта модуля — календарный день строкой 'YYYY-MM-DD'. Арифметика
// по таким строкам не зависит от смещения зоны и длины суток, поэтому вся
// раскладка считается на них, а моменты появляются только на границах.
export type DayKey = string;

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const clockFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const WEEKDAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Календарный день момента по Москве. */
export function dayKeyOf(ms: number): DayKey {
  return dayKeyFormat.format(new Date(ms));
}

/** Минуты от московской полуночи. */
export function minutesOf(ms: number): number {
  const [hour, minute] = clockFormat.format(new Date(ms)).split(':').map(Number);
  return hour * 60 + minute;
}

/** Момент по календарному дню и минутам от полуночи в Москве. */
export function instantOf(day: DayKey, minutes = 0): number {
  const asIfUtc = Date.parse(`${day}T00:00:00Z`) + minutes * 60000;
  return asIfUtc - moscowOffsetMs(new Date(asIfUtc));
}

export function todayKey(): DayKey {
  return dayKeyOf(Date.now());
}

export function addDays(day: DayKey, count: number): DayKey {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function addMonths(day: DayKey, count: number): DayKey {
  const [year, month] = day.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + count, 1));
  return date.toISOString().slice(0, 10);
}

/** Понедельник = 0: в России неделя начинается с понедельника, не с воскресенья. */
export function weekdayIndex(day: DayKey): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function startOfWeek(day: DayKey): DayKey {
  return addDays(day, -weekdayIndex(day));
}

export function startOfMonth(day: DayKey): DayKey {
  return `${day.slice(0, 7)}-01`;
}

export function isSameMonth(a: DayKey, b: DayKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** «2026-07» из дня — ключ месяца, которому он принадлежит. */
export function monthKeyOf(day: DayKey): string {
  return day.slice(0, 7);
}

export function dayNumber(day: DayKey): number {
  return Number(day.slice(8, 10));
}

export function isWeekend(day: DayKey): boolean {
  return weekdayIndex(day) >= 5;
}

/**
 * Сетка месяца: всегда шесть недель, с понедельника.
 *
 * Шесть, а не «сколько получится»: у месяца бывает от четырёх до шести
 * недельных строк, и плавающая высота сетки заставляла бы содержимое
 * прыгать при листании месяцев.
 */
export function monthGrid(anchor: DayKey): DayKey[][] {
  const first = startOfWeek(startOfMonth(anchor));
  const weeks: DayKey[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: DayKey[] = [];
    for (let day = 0; day < 7; day += 1) {
      days.push(addDays(first, week * 7 + day));
    }
    weeks.push(days);
  }
  return weeks;
}

export function weekDays(anchor: DayKey): DayKey[] {
  const first = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** Часы:минуты момента, «14:30». */
export function formatClock(ms: number): string {
  return clockFormat.format(new Date(ms));
}

/** «14:30» из минут от полуночи — для подписей сетки времени. */
export function formatMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function monthTitle(day: DayKey): string {
  const [year, month] = day.split('-').map(Number);
  return `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
}

/** Месяц для подсказки: год дописываем, только если он не текущий. */
export function monthShortTitle(day: DayKey): string {
  const [year, month] = day.split('-').map(Number);
  const suffix = String(year) === todayKey().slice(0, 4) ? '' : ` ${year}`;
  return `${MONTHS_NOMINATIVE[month - 1]}${suffix}`;
}

/** «4 августа», с годом — только если он не текущий. */
export function formatDayLong(day: DayKey): string {
  const [year, month] = day.split('-').map(Number);
  const suffix = String(year) === todayKey().slice(0, 4) ? '' : ` ${year}`;
  return `${dayNumber(day)} ${MONTHS_GENITIVE[month - 1]}${suffix}`;
}

/** Заголовок недели: «3 — 9 августа 2026». */
export function weekTitle(anchor: DayKey): string {
  const days = weekDays(anchor);
  const first = days[0];
  const last = days[6];
  const [, firstMonth] = first.split('-').map(Number);
  const [lastYear, lastMonth] = last.split('-').map(Number);

  const head = firstMonth === lastMonth
    ? String(dayNumber(first))
    : `${dayNumber(first)} ${MONTHS_GENITIVE[firstMonth - 1]}`;

  return `${head} — ${dayNumber(last)} ${MONTHS_GENITIVE[lastMonth - 1]} ${lastYear}`;
}

/** Значение для <input type="date"> — тот же формат, что и DayKey. */
export function toDateInput(ms: number): string {
  return dayKeyOf(ms);
}

/** Значение для <input type="time"> по московскому времени. */
export function toTimeInput(ms: number): string {
  return formatMinutes(minutesOf(ms));
}

export function minutesFromTimeInput(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

/** Ближайшие полчаса вперёд — разумное начало для нового события. */
export function nextHalfHour(day: DayKey = todayKey()): number {
  const now = Date.now();
  const minutes = dayKeyOf(now) === day ? Math.ceil(minutesOf(now) / 30) * 30 : 9 * 60;
  return Math.min(minutes, 23 * 60 + 30);
}
