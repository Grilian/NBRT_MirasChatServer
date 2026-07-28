const db = require('../db');
const {
  moscowDayKey,
  moscowMinutes,
  moscowInstant,
  addDays,
  addMonthsStrict,
  addYearsStrict,
} = require('../utils/moscowTime');

// Повторы разворачиваются на сервере, а не на клиенте. Клиент получает готовые
// вхождения и не знает про правила повторения вовсе — благодаря этому та же
// выборка одинаково работает и для личного календаря, и для календаря
// пространства, и для любого будущего виджета.
//
// Потолок на число вхождений: правило с интервалом 0 или испорченным until
// иначе крутило бы цикл до бесконечности прямо в обработчике запроса.
const MAX_OCCURRENCES = 400;

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

// «Без даты окончания» приходит как null, а Number(null) — это 0, то есть
// 1970 год. Без явной проверки бесконечная серия обрезалась бы полностью:
// любое вхождение оказывалось бы позже своего предела.
function parseUntil(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseRecurrence(raw) {
  if (!raw) return null;
  try {
    const rule = JSON.parse(raw);
    if (!FREQUENCIES.has(rule.freq)) return null;
    const interval = Number(rule.interval);
    return {
      freq: rule.freq,
      interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1,
      until: parseUntil(rule.until),
    };
  } catch {
    return null;
  }
}

// Следующий календарный день серии. null — такого дня не существует
// (31 число в коротком месяце, 29 февраля в невисокосный год); тогда вхождение
// пропускается, а серия продолжается дальше, как в Google Calendar.
function shiftDay(dayKey, rule, step) {
  const n = rule.interval * step;
  switch (rule.freq) {
    case 'daily': return addDays(dayKey, n);
    case 'weekly': return addDays(dayKey, n * 7);
    case 'monthly': return addMonthsStrict(dayKey, n);
    case 'yearly': return addYearsStrict(dayKey, n);
    default: return null;
  }
}

/**
 * Вхождения события, пересекающиеся с [from, to].
 *
 * Длительность берётся от исходного события и переносится на каждое вхождение:
 * так встреча на полтора часа остаётся полуторачасовой в любой неделе, даже
 * если правило сдвинуло её через границу месяца.
 */
function expandOccurrences(event, from, to) {
  const duration = Math.max(0, event.ends_at - event.starts_at);
  const rule = parseRecurrence(event.recurrence);

  if (!rule) {
    return event.starts_at <= to && event.ends_at >= from
      ? [{ start: event.starts_at, end: event.ends_at }]
      : [];
  }

  const baseDay = moscowDayKey(event.starts_at);
  const minutes = moscowMinutes(event.starts_at);
  const limit = rule.until === null ? to : Math.min(to, rule.until);

  const occurrences = [];
  for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
    const dayKey = step === 0 ? baseDay : shiftDay(baseDay, rule, step);
    if (dayKey === null) continue;

    const start = moscowInstant(dayKey, minutes);
    if (start > limit) break;

    const end = start + duration;
    if (end >= from && start <= to) occurrences.push({ start, end });
  }

  return occurrences;
}

const guestsStatement = db.prepare(`
  SELECT g.event_id, g.user_id, g.response,
         u.display_name, u.username, u.avatar_path
  FROM calendar_event_guests g
  JOIN users u ON u.id = g.user_id
  WHERE g.event_id = ?
`);

const completionsStatement = db.prepare(
  'SELECT occurrence_start FROM calendar_task_completions WHERE event_id = ?'
);

function serializeOccurrence(event, occurrence, userId, completions) {
  return {
    // Ключ вхождения, а не события: в сетке их может быть много от одной
    // серии, и React нужен стабильный, различимый id.
    id: `${event.id}:${occurrence.start}`,
    event_id: event.id,
    occurrence_start: occurrence.start,
    title: event.title,
    description: event.description,
    location: event.location,
    starts_at: occurrence.start,
    ends_at: occurrence.end,
    all_day: !!event.all_day,
    color: event.color,
    is_task: !!event.is_task,
    completed: completions.has(occurrence.start),
    recurring: !!event.recurrence,
    recurrence: event.recurrence ? JSON.parse(event.recurrence) : null,
    scope_kind: event.scope_kind,
    scope_id: event.scope_id,
    owner_id: event.owner_id,
    is_owner: event.owner_id === userId,
    source: 'calendar',
    guests: guestsStatement.all(event.id).map((g) => ({
      user_id: g.user_id,
      response: g.response,
      display_name: g.display_name || g.username,
      avatar_path: g.avatar_path,
    })),
  };
}

/**
 * События диапазона: свои плюс те, куда пригласили.
 *
 * Отбор по starts_at ограничен снизу окном в год: повторяющаяся серия могла
 * начаться задолго до запрошенного месяца, и без этого запаса она бы просто не
 * попала в выборку. Год покрывает все поддерживаемые правила, включая годовые.
 */
function listEvents({ userId, from, to, scopeKind = 'personal', scopeId = null }) {
  const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT DISTINCT e.*
    FROM calendar_events e
    LEFT JOIN calendar_event_guests g ON g.event_id = e.id
    WHERE (e.owner_id = ? OR g.user_id = ?)
      AND e.scope_kind = ?
      AND (e.scope_id IS ? OR e.scope_id = ?)
      AND e.starts_at <= ?
      AND (e.recurrence IS NOT NULL OR e.ends_at >= ?)
  `).all(userId, userId, scopeKind, scopeId, scopeId, to, from - YEAR_MS);

  const result = [];
  for (const event of rows) {
    const completions = new Set(
      completionsStatement.all(event.id).map((row) => row.occurrence_start)
    );
    for (const occurrence of expandOccurrences(event, from, to)) {
      result.push(serializeOccurrence(event, occurrence, userId, completions));
    }
  }

  return result.sort((a, b) => a.starts_at - b.starts_at);
}

/**
 * Дни рождения контактов как вхождения календаря — только для чтения.
 *
 * Отдельным источником, а не строками в calendar_events: это не события, а
 * представление поля профиля. Скопируй мы их в таблицу — пришлось бы
 * поддерживать копии в актуальном состоянии при каждой правке даты рождения.
 */
function listContactBirthdays({ userId, from, to }) {
  const contacts = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_path, u.birth_date
    FROM contacts c
    JOIN users u ON u.id = c.contact_user_id
    WHERE c.user_id = ? AND u.birth_date IS NOT NULL AND TRIM(u.birth_date) != ''
  `).all(userId);

  const fromYear = Number(moscowDayKey(from).slice(0, 4));
  const toYear = Number(moscowDayKey(to).slice(0, 4));

  const result = [];
  for (const contact of contacts) {
    const match = String(contact.birth_date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) continue;
    const [, birthYear, month, day] = match;

    for (let year = fromYear; year <= toYear; year += 1) {
      const dayKey = `${year}-${month}-${day}`;
      // 29 февраля в невисокосный год — дня рождения в этом году просто нет.
      if (new Date(`${dayKey}T00:00:00Z`).getUTCDate() !== Number(day)) continue;

      const start = moscowInstant(dayKey, 0);
      const end = moscowInstant(dayKey, 24 * 60) - 1;
      if (end < from || start > to) continue;

      const name = contact.display_name || contact.username;
      const age = year - Number(birthYear);

      result.push({
        id: `birthday_${contact.id}_${year}`,
        event_id: null,
        occurrence_start: start,
        title: age > 0 ? `${name} — ${age}` : name,
        description: null,
        location: null,
        starts_at: start,
        ends_at: end,
        all_day: true,
        color: 'birthday',
        is_task: false,
        completed: false,
        recurring: true,
        recurrence: null,
        scope_kind: 'personal',
        scope_id: null,
        owner_id: contact.id,
        is_owner: false,
        source: 'birthday',
        guests: [],
      });
    }
  }

  return result.sort((a, b) => a.starts_at - b.starts_at);
}

module.exports = { expandOccurrences, listEvents, listContactBirthdays, parseRecurrence };
