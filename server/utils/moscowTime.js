// Календарь живёт в московском времени независимо от зоны устройства — так же,
// как переписка (см. client/src/utils/time.ts). Для календаря это важнее, чем
// для сообщений: «встреча 14:00 во вторник» должна означать одно и то же у
// всех, иначе сетка месяца у человека в другой зоне разъедется на день.
//
// Основная валюта здесь — не момент времени, а календарный день строкой
// 'YYYY-MM-DD'. Арифметика по дням на строках не зависит ни от смещения зоны,
// ни от длины суток, поэтому раскладка сетки и повторы считаются именно так, а
// момент вычисляется только на выходе.
const MOSCOW_TZ = 'Europe/Moscow';

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: MOSCOW_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Смещение Москвы в миллисекундах на заданный момент. Через Intl, а не
// константой +3: зашитое смещение живёт до следующей правки часовых поясов.
function moscowOffsetMs(ms) {
  const at = new Date(ms);
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asMoscow = new Date(at.toLocaleString('en-US', { timeZone: MOSCOW_TZ }));
  return asMoscow.getTime() - asUtc.getTime();
}

/** Календарный день в Москве: 'YYYY-MM-DD'. */
function moscowDayKey(ms) {
  return dayKeyFormat.format(new Date(ms));
}

/** Минуты от московской полуночи. */
function moscowMinutes(ms) {
  const [hour, minute] = timeFormat.format(new Date(ms)).split(':').map(Number);
  return hour * 60 + minute;
}

/** Момент по календарному дню и минутам от полуночи в Москве. */
function moscowInstant(dayKey, minutes = 0) {
  const asIfUtc = Date.parse(`${dayKey}T00:00:00Z`) + minutes * 60000;
  return asIfUtc - moscowOffsetMs(asIfUtc);
}

/** Сдвиг календарного дня. Чистая арифметика по строке, без зон. */
function addDays(dayKey, days) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Сдвиг на месяцы с сохранением числа. Возвращает null, если такого числа в
 * целевом месяце нет: 31 января + 1 месяц — это не 3 марта. Повтор в такие
 * месяцы просто не попадает, как и в Google Calendar.
 */
function addMonthsStrict(dayKey, months) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  target.setUTCDate(day);
  // Перевалило на следующий месяц — значит числа в целевом не существует.
  if (target.getUTCDate() !== day) return null;
  return target.toISOString().slice(0, 10);
}

/** То же для лет: 29 февраля в невисокосный год не попадает. */
function addYearsStrict(dayKey, years) {
  return addMonthsStrict(dayKey, years * 12);
}

/** День недели, понедельник = 0 (в России неделя начинается с понедельника). */
function weekdayIndex(dayKey) {
  const day = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return (day + 6) % 7;
}

module.exports = {
  MOSCOW_TZ,
  moscowOffsetMs,
  moscowDayKey,
  moscowMinutes,
  moscowInstant,
  addDays,
  addMonthsStrict,
  addYearsStrict,
  weekdayIndex,
};
