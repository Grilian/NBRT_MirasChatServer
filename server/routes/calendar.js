const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { listEvents, listContactBirthdays } = require('../services/calendarEvents');

const router = express.Router();

// Цвета — именами, а не значениями. Тема у приложения светлая и тёмная, и
// сохранённый в базе #34a853 в тёмной выглядел бы ядовитым; имя же тема
// раскрашивает сама (см. --cal-* в theme.css).
const COLORS = new Set(['blue', 'green', 'red', 'orange', 'violet', 'teal', 'graphite']);
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

// Запрошенный диапазон ограничиваем: сетка месяца просит ~6 недель, год —
// 12 месяцев. Всё, что больше, — это либо ошибка в клиенте, либо попытка
// вытащить всю базу одним запросом.
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

function parseRange(req) {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  if (to - from > MAX_RANGE_MS) return null;
  return { from, to };
}

function parseScope(source) {
  const kind = source.scope_kind === 'space' ? 'space' : 'personal';
  const rawId = Number(source.scope_id);
  return { scopeKind: kind, scopeId: kind === 'space' && Number.isFinite(rawId) ? rawId : null };
}

// Приводим тело запроса к строкам таблицы. Клиенту доверять нельзя ни в
// длине текста, ни в согласованности границ: событие, у которого конец раньше
// начала, сломало бы раскладку сетки, а не только само себя.
function parseEventBody(body) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'Укажите название' };
  if (title.length > 200) return { error: 'Название слишком длинное' };

  const startsAt = Number(body.starts_at);
  const endsAt = Number(body.ends_at);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    return { error: 'Некорректное время' };
  }
  if (endsAt < startsAt) return { error: 'Конец раньше начала' };

  let recurrence = null;
  if (body.recurrence && body.recurrence.freq) {
    if (!FREQUENCIES.has(body.recurrence.freq)) return { error: 'Неизвестное правило повтора' };
    const interval = Number(body.recurrence.interval);
    const rawUntil = body.recurrence.until;
    // Number(null) === 0, поэтому «без даты окончания» проверяем явно —
    // иначе бесконечная серия сохранилась бы с пределом в 1970 году.
    const until = rawUntil === null || rawUntil === undefined || rawUntil === ''
      ? null
      : Number(rawUntil);
    recurrence = JSON.stringify({
      freq: body.recurrence.freq,
      interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1,
      until: Number.isFinite(until) ? until : null,
    });
  }

  const scope = parseScope(body);

  return {
    value: {
      title,
      description: body.description ? String(body.description).slice(0, 4000) : null,
      location: body.location ? String(body.location).slice(0, 300) : null,
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: body.all_day ? 1 : 0,
      color: COLORS.has(body.color) ? body.color : 'blue',
      recurrence,
      is_task: body.is_task ? 1 : 0,
      scope_kind: scope.scopeKind,
      scope_id: scope.scopeId,
    },
    guestIds: Array.isArray(body.guest_ids)
      ? [...new Set(body.guest_ids.map(Number).filter(Number.isFinite))]
      : [],
  };
}

function replaceGuests(eventId, ownerId, guestIds) {
  db.prepare('DELETE FROM calendar_event_guests WHERE event_id = ?').run(eventId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO calendar_event_guests (event_id, user_id) VALUES (?, ?)'
  );
  for (const userId of guestIds) {
    if (userId === ownerId) continue; // владелец и так участник
    insert.run(eventId, userId);
  }
}

function ownedEvent(eventId, userId) {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ? AND owner_id = ?')
    .get(eventId, userId);
}

// Вхождения диапазона. Источники раздельно — клиент показывает их разными
// слоями и умеет выключать дни рождения, не трогая события.
router.get('/events', verifyToken, (req, res) => {
  try {
    const range = parseRange(req);
    if (!range) return res.status(400).json({ error: 'Некорректный диапазон' });

    const scope = parseScope(req.query);
    const events = listEvents({ userId: req.userId, ...range, ...scope });

    // Дни рождения — понятие личное: в календаре пространства им не место.
    const birthdays = scope.scopeKind === 'personal' && req.query.birthdays !== '0'
      ? listContactBirthdays({ userId: req.userId, ...range })
      : [];

    res.json({ events, birthdays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/events', verifyToken, (req, res) => {
  try {
    const parsed = parseEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const now = Date.now();
    const event = parsed.value;
    const result = db.prepare(`
      INSERT INTO calendar_events
        (owner_id, scope_kind, scope_id, title, description, location,
         starts_at, ends_at, all_day, color, recurrence, is_task, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.userId, event.scope_kind, event.scope_id, event.title, event.description,
      event.location, event.starts_at, event.ends_at, event.all_day, event.color,
      event.recurrence, event.is_task, now, now
    );

    replaceGuests(result.lastInsertRowid, req.userId, parsed.guestIds);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/events/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!ownedEvent(id, req.userId)) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    const parsed = parseEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const event = parsed.value;
    db.prepare(`
      UPDATE calendar_events
      SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
          all_day = ?, color = ?, recurrence = ?, is_task = ?, updated_at = ?
      WHERE id = ?
    `).run(
      event.title, event.description, event.location, event.starts_at, event.ends_at,
      event.all_day, event.color, event.recurrence, event.is_task, Date.now(), id
    );

    // Правка времени или правила смещает вхождения — старые отметки о
    // выполнении привязаны к моментам, которых больше нет.
    db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(id);
    replaceGuests(id, req.userId, parsed.guestIds);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/events/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!ownedEvent(id, req.userId)) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_event_guests WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отметка о выполнении — по конкретному вхождению.
router.post('/events/:id/complete', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!ownedEvent(id, req.userId)) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    const occurrenceStart = Number(req.body.occurrence_start);
    if (!Number.isFinite(occurrenceStart)) {
      return res.status(400).json({ error: 'Некорректное вхождение' });
    }

    if (req.body.completed) {
      db.prepare(`
        INSERT OR IGNORE INTO calendar_task_completions (event_id, occurrence_start, completed_at)
        VALUES (?, ?, ?)
      `).run(id, occurrenceStart, Date.now());
    } else {
      db.prepare(
        'DELETE FROM calendar_task_completions WHERE event_id = ? AND occurrence_start = ?'
      ).run(id, occurrenceStart);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ответ на приглашение. Владелец правит событие, участник — только своё
// отношение к нему.
router.post('/events/:id/response', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const response = ['accepted', 'declined', 'pending'].includes(req.body.response)
      ? req.body.response
      : null;
    if (!response) return res.status(400).json({ error: 'Некорректный ответ' });

    const result = db.prepare(
      'UPDATE calendar_event_guests SET response = ? WHERE event_id = ? AND user_id = ?'
    ).run(response, id, req.userId);

    if (result.changes === 0) return res.status(404).json({ error: 'Приглашение не найдено' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
