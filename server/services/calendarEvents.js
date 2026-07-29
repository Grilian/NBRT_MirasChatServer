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

// Перенесённое вхождение могло уехать из запрошенного окна или, наоборот,
// приехать в него снаружи. Поэтому при наличии исключений сетку строим с
// запасом и отбираем уже по итоговому времени — иначе перенос «на неделю
// вперёд» просто исчезал бы из виду.
const EXCEPTION_MARGIN_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Вхождения события, пересекающиеся с [from, to].
 *
 * Длительность берётся от исходного события и переносится на каждое вхождение:
 * так встреча на полтора часа остаётся полуторачасовой в любой неделе, даже
 * если правило сдвинуло её через границу месяца.
 *
 * exceptions — правки отдельных вхождений, по ключу «где вхождение стояло по
 * правилу». Именно по исходному месту, а не по новому: иначе перенос ломал бы
 * связь с серией и при следующем переносе завёл бы второе исключение.
 */
function expandOccurrences(event, from, to, exceptions = null) {
  const duration = Math.max(0, event.ends_at - event.starts_at);
  const rule = parseRecurrence(event.recurrence);

  // Применяем правку и решаем, попадает ли получившееся в окно.
  const materialize = (slot, start, end) => {
    const exception = exceptions ? exceptions.get(slot) : undefined;
    if (exception && exception.kind === 'skip') return null;

    const final = exception && exception.kind === 'override'
      ? {
        slot,
        start: exception.starts_at,
        end: exception.ends_at,
        overrides: exception,
      }
      : { slot, start, end, overrides: null };

    return final.end >= from && final.start <= to ? final : null;
  };

  if (!rule) {
    const single = materialize(event.starts_at, event.starts_at, event.ends_at);
    return single ? [single] : [];
  }

  const baseDay = moscowDayKey(event.starts_at);
  const minutes = moscowMinutes(event.starts_at);
  const hasExceptions = !!(exceptions && exceptions.size);
  const scanTo = hasExceptions ? to + EXCEPTION_MARGIN_MS : to;
  const limit = rule.until === null ? scanTo : Math.min(scanTo, rule.until);

  const occurrences = [];
  for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
    const dayKey = step === 0 ? baseDay : shiftDay(baseDay, rule, step);
    if (dayKey === null) continue;

    const start = moscowInstant(dayKey, minutes);
    if (start > limit) break;

    const materialized = materialize(start, start, start + duration);
    if (materialized) occurrences.push(materialized);
  }

  return occurrences;
}

const exceptionsStatement = db.prepare(
  'SELECT * FROM calendar_event_exceptions WHERE event_id = ?'
);

const remindersStatement = db.prepare(
  'SELECT minutes_before FROM calendar_event_reminders WHERE event_id = ? ORDER BY minutes_before'
);

function remindersFor(eventId) {
  return remindersStatement.all(eventId).map((row) => row.minutes_before);
}

function exceptionsFor(eventId) {
  const map = new Map();
  for (const row of exceptionsStatement.all(eventId)) map.set(row.occurrence_start, row);
  return map;
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

function serializeOccurrence(event, occurrence, userId, completions, canEditGlobal) {
  const isOwner = event.owner_id === userId;
  // Общее событие правит любой администратор или модератор, а не только тот,
  // кто его завёл: объявление на всю организацию не должно застревать из-за
  // того, что автор в отпуске.
  const canEdit = event.scope_kind === 'global' ? canEditGlobal : isOwner;

  const guests = guestsStatement.all(event.id).map((g) => ({
    user_id: g.user_id,
    response: g.response,
    display_name: g.display_name || g.username,
    avatar_path: g.avatar_path,
  }));

  // Правка одного вхождения перекрывает поля серии. Пустое поле в исключении
  // означает «как у серии», а не «пусто»: перенос времени не должен стирать
  // название.
  const patch = occurrence.overrides;
  const pick = (field) => (patch && patch[field] !== null && patch[field] !== undefined
    ? patch[field]
    : event[field]);

  return {
    // Ключ вхождения, а не события: в сетке их может быть много от одной
    // серии, и React нужен стабильный, различимый id.
    id: `${event.id}:${occurrence.slot}`,
    event_id: event.id,
    // Место вхождения в серии, а не его текущее время: по нему привязаны и
    // отметка о выполнении, и сама правка. После переноса оно не меняется,
    // иначе следующий перенос завёл бы второе исключение вместо правки первого.
    occurrence_start: occurrence.slot,
    title: pick('title'),
    description: pick('description'),
    location: pick('location'),
    starts_at: occurrence.start,
    ends_at: occurrence.end,
    all_day: !!pick('all_day'),
    color: pick('color'),
    is_task: !!event.is_task,
    completed: completions.has(occurrence.slot),
    recurring: !!event.recurrence,
    /** Вхождение серии, отличающееся от неё: перенесено или переименовано. */
    is_exception: !!patch,
    recurrence: event.recurrence ? JSON.parse(event.recurrence) : null,
    scope_kind: event.scope_kind,
    scope_id: event.scope_id,
    owner_id: event.owner_id,
    is_owner: isOwner,
    can_edit: canEdit,
    // Приглашён ли именно этот человек. Без этого признака клиент не отличает
    // «меня позвали» от «я просто вижу общее событие» и предлагает ответить
    // на приглашение там, где отвечать не на что.
    is_guest: guests.some((guest) => guest.user_id === userId),
    reminders: remindersFor(event.id),
    source: 'calendar',
    guests,
  };
}

// Повторяющаяся серия могла начаться задолго до запрошенного месяца, поэтому
// снизу диапазон расширяется на год — без этого запаса такая серия просто не
// попала бы в выборку. Год покрывает все поддерживаемые правила, включая годовые.
const LOOKBACK_MS = 366 * 24 * 60 * 60 * 1000;

const RANGE_CONDITION = `
  e.starts_at <= ?
  AND (e.recurrence IS NOT NULL OR e.ends_at >= ?)
`;

/**
 * Всё, что человек вправе видеть в диапазоне: общие события плюс личные — свои
 * и те, куда пригласили.
 *
 * Слои не разделяются здесь намеренно. Каждое вхождение несёт свой scope_kind,
 * и группировку делает клиент: переключение слоя не должно ходить на сервер за
 * тем, что уже загружено. Календари пространств добавятся сюда же условием по
 * членству, когда пространства появятся.
 */
function listVisibleEvents({ userId, from, to, canEditGlobal = false }) {
  const rows = db.prepare(`
    SELECT DISTINCT e.*
    FROM calendar_events e
    LEFT JOIN calendar_event_guests g ON g.event_id = e.id
    WHERE (
      e.scope_kind = 'global'
      OR (e.scope_kind = 'personal' AND (e.owner_id = ? OR g.user_id = ?))
    )
    AND ${RANGE_CONDITION}
  `).all(userId, userId, to, from - LOOKBACK_MS);

  return buildOccurrences(rows, { userId, from, to, canEditGlobal });
}

/**
 * События одной области — для списка внутри пространства и прочих врезок, где
 * нужен не весь календарь, а конкретный его слой.
 */
function listEvents({ userId, from, to, scopeKind = 'personal', scopeId = null, canEditGlobal = false }) {
  const rows = db.prepare(`
    SELECT DISTINCT e.*
    FROM calendar_events e
    LEFT JOIN calendar_event_guests g ON g.event_id = e.id
    WHERE e.scope_kind = ?
      AND (e.scope_id IS ? OR e.scope_id = ?)
      AND (e.scope_kind = 'global' OR e.owner_id = ? OR g.user_id = ?)
      AND ${RANGE_CONDITION}
  `).all(scopeKind, scopeId, scopeId, userId, userId, to, from - LOOKBACK_MS);

  return buildOccurrences(rows, { userId, from, to, canEditGlobal });
}

function buildOccurrences(rows, { userId, from, to, canEditGlobal }) {
  const result = [];
  for (const event of rows) {
    const completions = new Set(
      completionsStatement.all(event.id).map((row) => row.occurrence_start)
    );
    const exceptions = event.recurrence ? exceptionsFor(event.id) : null;
    for (const occurrence of expandOccurrences(event, from, to, exceptions)) {
      result.push(serializeOccurrence(event, occurrence, userId, completions, canEditGlobal));
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
        is_exception: false,
        reminders: [],
        recurrence: null,
        scope_kind: 'personal',
        scope_id: null,
        owner_id: contact.id,
        is_owner: false,
        can_edit: false,
        is_guest: false,
        source: 'birthday',
        guests: [],
      });
    }
  }

  return result.sort((a, b) => a.starts_at - b.starts_at);
}

module.exports = {
  expandOccurrences,
  exceptionsFor,
  remindersFor,
  listVisibleEvents,
  listEvents,
  listContactBirthdays,
  parseRecurrence,
};
