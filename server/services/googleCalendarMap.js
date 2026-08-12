const {
  MOSCOW_TZ,
  moscowDayKey,
  moscowMinutes,
  moscowInstant,
  addDays,
  addMonthsStrict,
  addYearsStrict,
  weekdayIndex,
} = require('../utils/moscowTime');

// Перевод между нашим событием и событием Google Календаря.
//
// Модели сходятся не полностью, и вся сложность здесь — в честном признании
// того, где именно они расходятся. Наше правило повтора — это ровно
// {freq, interval, until}, тогда как RRULE умеет «каждый второй вторник и
// четверг месяца». Такие события мы читаем упрощённо и НИКОГДА не отправляем
// обратно (push_blocked): отправить значило бы переписать в чужом календаре
// наше приближение поверх настоящего правила.

// Ключ, по которому мы узнаём в гугле собственные события. Нужен не для
// синхронизации (для неё есть таблица привязок), а для восстановления связи:
// если базу подняли из бэкапа, привязки старые, а события в гугле те же.
const EVENT_ID_PROPERTY = 'nbrtEventId';

const OUR_COLORS = new Set(['blue', 'green', 'red', 'orange', 'violet', 'teal', 'graphite']);

// Цвета Google — номера палитры событий. Соответствие приблизительное: у нас
// семь имён, у гугла одиннадцать, и точного попадания не существует.
const COLOR_TO_GOOGLE = {
  blue: '9', green: '10', red: '11', orange: '6', violet: '3', teal: '7', graphite: '8',
};
const COLOR_FROM_GOOGLE = {
  1: 'violet', 2: 'green', 3: 'violet', 4: 'red', 5: 'orange', 6: 'orange',
  7: 'teal', 8: 'graphite', 9: 'blue', 10: 'green', 11: 'red',
};

const FREQ_TO_RRULE = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
const FREQ_FROM_RRULE = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Потолок при разворачивании COUNT в дату окончания. Тот же порядок, что и
// MAX_OCCURRENCES в calendarEvents.js: правило с COUNT=100000 не должно
// крутить цикл внутри обработчика.
const MAX_COUNT_STEPS = 1000;

const clamp = (value, limit) => (value === null || value === undefined
  ? null
  : String(value).slice(0, limit));

// ===== Время =====

/**
 * Границы события в формате Google.
 *
 * Событие на весь день у нас — от полуночи до 23:59 последнего дня
 * (см. EventDialog.buildDraft), а у Google — полуоткрытый интервал дат, где
 * end.date уже НЕ входит в событие. Отсюда +1 день при отправке и −1 при
 * чтении: без этого однодневное событие уезжало бы в гугл нулевой длины и
 * пропадало из сетки.
 */
function toGoogleTimes(event) {
  if (event.all_day) {
    return {
      start: { date: moscowDayKey(event.starts_at) },
      end: { date: addDays(moscowDayKey(event.ends_at), 1) },
    };
  }
  return {
    // Момент отдаём в UTC, а зону — отдельным полем: она задаёт не смещение
    // (оно уже в самой метке), а то, в какой зоне гугл разворачивает повторы.
    // Без неё серия «каждый вторник в 10:00» переехала бы на час при переводе
    // часов в зоне сервера.
    start: { dateTime: new Date(event.starts_at).toISOString(), timeZone: MOSCOW_TZ },
    end: { dateTime: new Date(event.ends_at).toISOString(), timeZone: MOSCOW_TZ },
  };
}

/** Границы гуглового события в наших миллисекундах. null — время не разобрать. */
function fromGoogleTimes(googleEvent) {
  const start = googleEvent.start || {};
  const end = googleEvent.end || {};

  if (start.date) {
    const startDay = start.date;
    // end.date исключающий, поэтому последний день события — предыдущий.
    const endDay = end.date ? addDays(end.date, -1) : startDay;
    return {
      all_day: 1,
      starts_at: moscowInstant(startDay, 0),
      // Минута до полуночи, а не сама полночь: иначе событие одной точкой
      // залезало бы в следующий день, ровно как отмечено в EventDialog.
      ends_at: moscowInstant(endDay < startDay ? startDay : endDay, 24 * 60) - 60000,
    };
  }

  const startsAt = Date.parse(start.dateTime);
  if (!Number.isFinite(startsAt)) return null;
  const endsAt = Date.parse(end.dateTime);
  return {
    all_day: 0,
    starts_at: startsAt,
    ends_at: Number.isFinite(endsAt) ? endsAt : startsAt,
  };
}

// ===== Правило повтора =====

/** UNTIL в формате RRULE: датой для событий на весь день, меткой UTC — для остальных. */
function formatUntil(ms, allDay) {
  if (allDay) return moscowDayKey(ms).replace(/-/g, '');
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Метка RRULE в миллисекунды. dayMinutes задаёт, куда попадает дата без
 * времени, и у двух пользователей этой функции ответ РАЗНЫЙ:
 *
 * UNTIL=20260820 — это «весь двадцатое включительно», то есть конец дня; взяв
 * полночь, мы срезали бы последнее вхождение серии как «позже предела».
 * EXDATE;VALUE=DATE:20260820 — наоборот, указывает на само вхождение, а оно
 * стоит на начале дня (см. moscowInstant(dayKey, minutes) в calendarEvents.js);
 * конец дня не совпал бы с ключом ни одного исключения, и пропуск потерялся бы.
 */
function parseStamp(raw, dayMinutes) {
  const value = String(raw || '');
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) return moscowInstant(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, dayMinutes);

  const full = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!full) return null;
  const [, y, m, d, hh, mm, ss, zulu] = full;
  const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  // Без Z метка дана в зоне события, а она у нас всегда московская.
  return zulu ? Date.parse(`${iso}Z`) : moscowInstant(`${y}-${m}-${d}`, Number(hh) * 60 + Number(mm));
}

const parseUntil = (raw) => parseStamp(raw, 24 * 60);

/** Наше правило → строки поля recurrence в Google. */
function toGoogleRecurrence(event) {
  if (!event.recurrence) return undefined;
  let rule;
  try {
    rule = JSON.parse(event.recurrence);
  } catch {
    return undefined;
  }
  const freq = FREQ_TO_RRULE[rule.freq];
  if (!freq) return undefined;

  const parts = [`FREQ=${freq}`];
  const interval = Number(rule.interval);
  if (Number.isFinite(interval) && interval > 1) parts.push(`INTERVAL=${Math.floor(interval)}`);
  if (Number.isFinite(Number(rule.until)) && rule.until) {
    parts.push(`UNTIL=${formatUntil(Number(rule.until), event.all_day)}`);
  }
  return [`RRULE:${parts.join(';')}`];
}

/**
 * Разбор RRULE в наше правило.
 *
 * Возвращает { rule, supported }. supported === false значит, что правило
 * богаче нашей модели: правило мы всё равно приближаем (иначе событие вообще
 * не показалось бы), но обратно такое событие не отправляем.
 *
 * BYDAY/BYMONTHDAY/BYMONTH проверяются, а не отвергаются с порога: Google
 * дописывает их к обычным правилам избыточно — у «каждый вторник» появляется
 * BYDAY=TU, повторяющий день самого события. Такое ограничение ничего не
 * добавляет к правилу, и считать его непереводимым значило бы записать в
 * «только для чтения» половину нормальных еженедельных встреч.
 */
function parseRRule(line, startsAt, allDay) {
  const body = String(line).replace(/^RRULE:/i, '');
  const params = new Map();
  for (const chunk of body.split(';')) {
    const [key, value] = chunk.split('=');
    if (key) params.set(key.trim().toUpperCase(), (value || '').trim());
  }

  const freq = FREQ_FROM_RRULE[params.get('FREQ')];
  if (!freq) return { rule: null, supported: false };

  const rawInterval = Number(params.get('INTERVAL'));
  const interval = Number.isFinite(rawInterval) && rawInterval > 0 ? Math.floor(rawInterval) : 1;

  let supported = true;
  const dayKey = moscowDayKey(startsAt);

  const byDay = params.get('BYDAY');
  if (byDay) {
    const days = byDay.split(',').map((d) => d.trim().toUpperCase());
    // Избыточно только одно значение, совпадающее с днём самого события, и
    // только без порядкового префикса: «2TU» — это второй вторник месяца, а
    // такого понятия у нас нет вовсе.
    const expected = WEEKDAY_CODES[weekdayIndex(dayKey)];
    if (days.length !== 1 || days[0] !== expected) supported = false;
  }

  const byMonthDay = params.get('BYMONTHDAY');
  if (byMonthDay && Number(byMonthDay) !== Number(dayKey.slice(8, 10))) supported = false;

  const byMonth = params.get('BYMONTH');
  if (byMonth && Number(byMonth) !== Number(dayKey.slice(5, 7))) supported = false;

  // Всё остальное наша модель не выражает даже приближённо.
  for (const key of ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']) {
    if (params.has(key)) supported = false;
  }

  let until = null;
  if (params.has('UNTIL')) {
    until = parseUntil(params.get('UNTIL'));
  } else if (params.has('COUNT')) {
    until = untilFromCount(startsAt, { freq, interval }, Number(params.get('COUNT')));
  }

  return { rule: { freq, interval, until }, supported };
}

/**
 * COUNT в дату окончания. Своей арифметикой по дням — той же, что разворачивает
 * серии в calendarEvents.js, — иначе «10 повторов» у нас и в гугле разъехались
 * бы на несуществующих числах (31-е в коротком месяце пропускается обеими
 * сторонами, но считать пропуск повтором нельзя).
 */
function untilFromCount(startsAt, rule, count) {
  if (!Number.isFinite(count) || count < 1) return null;
  const baseDay = moscowDayKey(startsAt);
  const minutes = moscowMinutes(startsAt);
  let seen = 0;

  for (let step = 0; step < MAX_COUNT_STEPS; step += 1) {
    const dayKey = step === 0 ? baseDay : shiftDay(baseDay, rule, step);
    if (dayKey === null) continue;
    seen += 1;
    // Предел включающий: доходим до последнего нужного вхождения и берём
    // минуту после него, чтобы само оно в серию попало.
    if (seen >= count) return moscowInstant(dayKey, minutes) + 60000;
  }
  return null;
}

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
 * Поле recurrence гуглового события целиком.
 *
 * RDATE — отдельные добавленные даты вне правила. Выразить их нечем, и
 * молча потерять тоже нельзя: помечаем событие как непереводимое.
 * EXDATE — наоборот, ложится ровно на наши исключения kind='skip'.
 */
function fromGoogleRecurrence(lines, startsAt, allDay) {
  if (!Array.isArray(lines) || !lines.length) {
    return { recurrence: null, supported: true, skips: [] };
  }

  let parsed = null;
  let supported = true;
  const skips = [];

  for (const line of lines) {
    const upper = String(line).toUpperCase();
    if (upper.startsWith('RRULE')) {
      // Несколько RRULE в одном событии — законно по RFC и неописуемо у нас.
      if (parsed) { supported = false; continue; }
      const result = parseRRule(line, startsAt, allDay);
      parsed = result.rule;
      if (!result.supported) supported = false;
    } else if (upper.startsWith('EXDATE')) {
      for (const stamp of exdateValues(line)) skips.push(stamp);
    } else if (upper.startsWith('RDATE')) {
      supported = false;
    }
  }

  if (!parsed) return { recurrence: null, supported: false, skips };
  return { recurrence: JSON.stringify(parsed), supported, skips };
}

function exdateValues(line) {
  const value = String(line).slice(String(line).indexOf(':') + 1);
  const result = [];
  for (const raw of value.split(',')) {
    const ms = parseStamp(raw.trim(), 0);
    if (ms !== null) result.push(ms);
  }
  return result;
}

// ===== Событие целиком =====

/** Наше событие → тело запроса к Google. */
function toGoogleEvent(event) {
  const times = toGoogleTimes(event);
  return {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start: times.start,
    end: times.end,
    recurrence: toGoogleRecurrence(event),
    colorId: COLOR_TO_GOOGLE[event.color] || undefined,
    extendedProperties: { private: { [EVENT_ID_PROPERTY]: String(event.id) } },
  };
}

/**
 * Гугловое событие → поля нашей строки. null — событие непригодно (нет
 * времени, например): такое пропускаем, а не заводим наполовину.
 *
 * Возвращает ещё supported и skips — их использует синхронизация, чтобы
 * запретить обратную отправку и завести исключения серии.
 */
function fromGoogleEvent(googleEvent) {
  const times = fromGoogleTimes(googleEvent);
  if (!times) return null;

  const recurrence = fromGoogleRecurrence(
    googleEvent.recurrence, times.starts_at, times.all_day
  );

  const colorId = Number(googleEvent.colorId);
  const color = COLOR_FROM_GOOGLE[colorId];

  return {
    fields: {
      // Пустое название в гугле законно, у нас — нет: title объявлен NOT NULL,
      // да и пустая строка в сетке выглядела бы дырой.
      title: clamp(googleEvent.summary, 200) || 'Без названия',
      description: clamp(googleEvent.description, 4000),
      location: clamp(googleEvent.location, 300),
      starts_at: times.starts_at,
      ends_at: times.ends_at,
      all_day: times.all_day,
      color: OUR_COLORS.has(color) ? color : 'blue',
      recurrence: recurrence.recurrence,
      // Задача — наше понятие, в гугле его нет. Импортированное всегда событие.
      is_task: 0,
    },
    // Серия без правила, которое мы смогли прочитать, — тоже непереводимая:
    // отправив её обратно, мы стёрли бы в гугле само правило.
    supported: recurrence.supported,
    skips: recurrence.skips,
  };
}

/** Момент, на который в серии стоит это вхождение (для исключений). */
function originalStartOf(googleEvent) {
  const original = googleEvent.originalStartTime;
  if (!original) return null;
  if (original.date) return moscowInstant(original.date, 0);
  const ms = Date.parse(original.dateTime);
  return Number.isFinite(ms) ? ms : null;
}

/** Наш ли это событие: проставленную нами метку гугл возвращает как есть. */
function ourEventId(googleEvent) {
  const raw = googleEvent.extendedProperties?.private?.[EVENT_ID_PROPERTY];
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

module.exports = {
  EVENT_ID_PROPERTY,
  toGoogleTimes,
  fromGoogleTimes,
  toGoogleRecurrence,
  fromGoogleRecurrence,
  parseRRule,
  untilFromCount,
  toGoogleEvent,
  fromGoogleEvent,
  originalStartOf,
  ourEventId,
};
