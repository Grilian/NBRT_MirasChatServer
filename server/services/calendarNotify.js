const db = require('../db');
const { notifyCalendar } = require('./push');
const { moscowDayKey, moscowMinutes } = require('../utils/moscowTime');

// Доставка уведомлений календаря. Два канала, как и у сообщений: сокет для
// тех, кто сейчас в приложении, и пуш — чтобы дошло до свёрнутого телефона.
// Ни один из них не обязателен: календарь остаётся рабочим, даже если оба
// молчат, поэтому ошибки здесь только логируются.

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** «завтра в 14:00», «3 августа в 09:30» — то, что читается в одну строку. */
function describeWhen(startsAt, allDay) {
  const day = moscowDayKey(startsAt);
  const today = moscowDayKey(Date.now());

  const [year, month, date] = day.split('-').map(Number);
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  let when;
  if (day === today) when = 'сегодня';
  else if (day === tomorrow.toISOString().slice(0, 10)) when = 'завтра';
  else when = `${date} ${MONTHS[month - 1]}`;

  if (allDay) return when;

  const minutes = moscowMinutes(startsAt);
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return `${when} в ${clock}`;
}

/** Кому это событие адресовано: владелец плюс приглашённые, кроме отказавшихся. */
function recipientsOf(event) {
  const guests = db.prepare(
    "SELECT user_id FROM calendar_event_guests WHERE event_id = ? AND response != 'declined'"
  ).all(event.id).map((row) => row.user_id);

  return Array.from(new Set([event.owner_id, ...guests]));
}

function deliver(io, userId, payload) {
  if (io) io.to('user:' + userId).emit('calendar_notification', payload);
  notifyCalendar(userId, payload).catch(() => { /* уже залогировано внутри */ });
}

/**
 * Позвали на событие. Шлём только тем, кого добавили сейчас: при каждой правке
 * события уведомлять всех подряд — верный способ добиться, чтобы уведомления
 * начали игнорировать.
 */
function notifyInvited(io, event, userIds) {
  if (!userIds.length) return;

  const owner = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(event.owner_id);
  const ownerName = owner ? (owner.display_name || owner.username) : 'Коллега';
  const when = describeWhen(event.starts_at, !!event.all_day);

  for (const userId of userIds) {
    if (userId === event.owner_id) continue;
    deliver(io, userId, {
      type: 'calendar_invite',
      eventId: event.id,
      title: `${ownerName} приглашает`,
      body: `${event.title} — ${when}`,
    });
  }
}

/** Напоминание о скором событии. */
function notifyReminder(io, event, occurrenceStart, minutesBefore) {
  const when = describeWhen(occurrenceStart, !!event.all_day);
  const lead = minutesBefore >= 1440
    ? `за ${Math.round(minutesBefore / 1440)} дн.`
    : minutesBefore >= 60
      ? `за ${Math.round(minutesBefore / 60)} ч`
      : `за ${minutesBefore} мин`;

  for (const userId of recipientsOf(event)) {
    deliver(io, userId, {
      type: 'calendar_reminder',
      eventId: event.id,
      title: event.title,
      body: `${when} · напоминание ${lead}`,
    });
  }
}

module.exports = { notifyInvited, notifyReminder, describeWhen, recipientsOf };
