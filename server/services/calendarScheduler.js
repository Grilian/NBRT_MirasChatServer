const db = require('../db');
const { expandOccurrences, exceptionsFor } = require('./calendarEvents');
const { notifyReminder } = require('./calendarNotify');

// Планировщик напоминаний.
//
// Состояние целиком в базе: на каждом тике заново считаем, что наступило, и
// сверяемся с таблицей отправленных. Держать таймеры в памяти нельзя —
// перезапуск pm2 (а он случается при каждой выкладке) потерял бы все
// напоминания, которые ещё не сработали.
const TICK_MS = 60 * 1000;

// Насколько поздно ещё имеет смысл напомнить. Если сервер лежал час, слать
// напоминания о встречах, которые уже прошли, — только раздражать. Полчаса
// покрывают обычный перезапуск и не воскрешают вчерашнее.
const GRACE_MS = 30 * 60 * 1000;

// Горизонт, в котором ищем вхождения. Самое дальнее поддерживаемое
// напоминание — за неделю, плюс запас на длину самих суток.
const HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

const markSent = db.prepare(`
  INSERT OR IGNORE INTO calendar_reminders_sent (event_id, occurrence_start, minutes_before, sent_at)
  VALUES (?, ?, ?, ?)
`);

/**
 * Один проход: найти напоминания, чей момент наступил, и разослать их.
 *
 * Возвращает число отправленных — нужно тестам и логу, чтобы отличить
 * «ничего не было» от «планировщик не работает».
 */
function runTick(io, now = Date.now()) {
  let sent = 0;

  try {
    // Только события, у которых вообще есть напоминания: обходить весь
    // календарь на каждом тике незачем.
    const events = db.prepare(`
      SELECT DISTINCT e.*
      FROM calendar_events e
      JOIN calendar_event_reminders r ON r.event_id = e.id
    `).all();

    for (const event of events) {
      const reminders = db.prepare(
        'SELECT minutes_before FROM calendar_event_reminders WHERE event_id = ?'
      ).all(event.id).map((row) => row.minutes_before);

      if (!reminders.length) continue;

      const exceptions = event.recurrence ? exceptionsFor(event.id) : null;
      // Окно берём с запасом назад: напоминание «за неделю» относится к
      // вхождению, которое ещё далеко впереди, а «за 10 минут» — к почти
      // наступившему.
      const occurrences = expandOccurrences(event, now - GRACE_MS, now + HORIZON_MS, exceptions);

      for (const occurrence of occurrences) {
        for (const minutesBefore of reminders) {
          const fireAt = occurrence.start - minutesBefore * 60000;
          if (fireAt > now) continue;          // ещё рано
          if (now - fireAt > GRACE_MS) continue; // уже поздно, не воскрешаем

          const result = markSent.run(event.id, occurrence.slot, minutesBefore, now);
          // changes === 0 значит это напоминание уже отправляли: вставка
          // и есть защита от повтора, отдельной проверки не нужно.
          if (result.changes === 0) continue;

          notifyReminder(io, event, occurrence.start, minutesBefore);
          sent += 1;
        }
      }
    }
  } catch (e) {
    console.error('[календарь] ошибка тика напоминаний:', e.message);
  }

  return sent;
}

function start(io) {
  // unref: планировщик не должен сам по себе держать процесс живым — за это
  // отвечает http-сервер. Иначе node не завершился бы по Ctrl+C.
  const timer = setInterval(() => runTick(io), TICK_MS);
  timer.unref();
  console.log('[календарь] планировщик напоминаний запущен');
  return timer;
}

module.exports = { start, runTick };
