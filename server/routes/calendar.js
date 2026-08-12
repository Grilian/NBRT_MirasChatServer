const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { listEvents, listVisibleEvents, listContactBirthdays } = require('../services/calendarEvents');
const { notifyInvited } = require('../services/calendarNotify');
const { recordLocalDeletion } = require('../services/googleCalendarSync');

const router = express.Router();

// Цвета — именами, а не значениями. Тема у приложения светлая и тёмная, и
// сохранённый в базе #34a853 в тёмной выглядел бы ядовитым; имя же тема
// раскрашивает сама (см. --cal-* в theme.css).
const COLORS = new Set(['blue', 'green', 'red', 'orange', 'violet', 'teal', 'graphite']);
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

// Напоминания фиксированным набором: произвольное число минут из запроса
// означало бы «за 100000 минут», а планировщик ищет вхождения в окне восьми
// суток и такое напоминание просто никогда не сработало бы.
const REMINDER_CHOICES = new Set([0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]);

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

const SCOPE_KINDS = new Set(['personal', 'global', 'space']);

function parseScope(source) {
  const kind = SCOPE_KINDS.has(source.scope_kind) ? source.scope_kind : 'personal';
  const rawId = Number(source.scope_id);
  return { scopeKind: kind, scopeId: kind === 'space' && Number.isFinite(rawId) ? rawId : null };
}

// Общий календарь наполняют администраторы и модераторы. Роль читаем из базы,
// а не из токена: обычные токены бессрочные, и роль могли сменить уже после
// выдачи — та же причина, что и в middleware/requireAdminRole.js.
function canPublishGlobal(userId) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return !!user && (user.role === 'admin' || user.role === 'moderator');
}

// Тип "Интернет" (незнакомые с улицы) не должен видеть общий календарь целиком
// организации — только свои личные события. Тот же принцип ограничения
// видимости, что уже применяется к справочнику людей в routes/users.js.
/**
 * Дополнительные календари, прочитанные из Google, — по одному слою на каждый.
 *
 * Основной сюда не попадает: его события ложатся в общий календарь и своего
 * слоя не образуют.
 */
function listGoogleCalendarLayers() {
  return db.prepare(`
    SELECT id, name, color FROM google_calendar_sources
    WHERE is_main = 0 ORDER BY id
  `).all().map((row) => ({
    id: row.id,
    name: row.name || 'Календарь Google',
    color: row.color,
  }));
}

function canSeeGlobalCalendar(userId) {
  const user = db.prepare('SELECT account_type FROM users WHERE id = ?').get(userId);
  return !user || user.account_type !== 'internet';
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
    reminders: Array.isArray(body.reminders)
      ? [...new Set(body.reminders.map(Number).filter((m) => REMINDER_CHOICES.has(m)))]
      : [],
  };
}

function replaceReminders(eventId, reminders) {
  db.prepare('DELETE FROM calendar_event_reminders WHERE event_id = ?').run(eventId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO calendar_event_reminders (event_id, minutes_before) VALUES (?, ?)'
  );
  for (const minutes of reminders) insert.run(eventId, minutes);
}

/** Кого добавили в участники по сравнению с тем, что было. */
function newlyInvited(eventId, guestIds) {
  const existing = new Set(
    db.prepare('SELECT user_id FROM calendar_event_guests WHERE event_id = ?')
      .all(eventId).map((row) => row.user_id)
  );
  return guestIds.filter((id) => !existing.has(id));
}

/**
 * Вправе ли человек писать в эту область. Возвращает текст ошибки или null.
 *
 * Проверка обязательна на запись, а не только на чтение: scope приходит прямо
 * из тела запроса, и без неё любой мог бы объявить своё событие общим, просто
 * подставив scope_kind.
 */
function scopeWriteError(scopeKind, userId) {
  if (scopeKind === 'global' && !canPublishGlobal(userId)) {
    return 'Общий календарь ведут администраторы и модераторы';
  }
  // Пространств ещё нет, а значит нет и понятия «участник» — принять такое
  // событие означало бы завести строку, доступ к которой никто не проверяет.
  if (scopeKind === 'space') {
    return 'Календари пространств пока не поддерживаются';
  }
  return null;
}

function replaceGuests(eventId, ownerId, guestIds) {
  db.prepare('DELETE FROM calendar_event_guests WHERE event_id = ?').run(eventId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO calendar_event_guests (event_id, user_id) VALUES (?, ?)'
  );
  // Проверяем, что такой человек есть. Внешние ключи в SQLite включены, и
  // несуществующий id уронил бы вставку с 500 — при том что виноват запрос,
  // а не сервер.
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  for (const userId of guestIds) {
    if (userId === ownerId) continue; // владелец и так участник
    if (!exists.get(userId)) continue;
    insert.run(eventId, userId);
  }
}

/**
 * Событие, которое этот человек вправе менять. null — нет такого либо нет прав.
 *
 * Личное правит владелец. Общее — любой администратор или модератор, а не
 * только автор: объявление на всю организацию не должно застревать из-за того,
 * что тот, кто его завёл, в отпуске.
 */
function editableEvent(eventId, userId) {
  const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
  if (!event) return null;
  // Зеркало чужого календаря не правит никто, включая того, от чьего имени
  // события импортируются: он указан владельцем лишь потому, что owner_id не
  // может быть пустым, а не потому, что события его.
  if (event.scope_kind === 'gcal') return null;
  if (event.scope_kind === 'global') return canPublishGlobal(userId) ? event : null;
  return event.owner_id === userId ? event : null;
}

/**
 * Вхождения диапазона.
 *
 * Без параметра scope_kind отдаётся всё, что человеку положено видеть, — общее
 * и личное вперемешку, каждое со своим scope_kind. Разделение на слои делает
 * клиент: переключить слой не должно значить сходить на сервер.
 *
 * С параметром — только указанная область. Это для врезок: список ближайших
 * событий в карточке пространства, где весь календарь не нужен.
 */
router.get('/events', verifyToken, (req, res) => {
  try {
    const range = parseRange(req);
    if (!range) return res.status(400).json({ error: 'Некорректный диапазон' });

    const canEditGlobal = canPublishGlobal(req.userId);
    const includeGlobal = canSeeGlobalCalendar(req.userId);
    const filtered = SCOPE_KINDS.has(req.query.scope_kind);
    const requestedGlobal = filtered && parseScope(req.query).scopeKind === 'global';

    const events = requestedGlobal && !includeGlobal
      ? []
      : filtered
        ? listEvents({ userId: req.userId, ...range, ...parseScope(req.query), canEditGlobal })
        : listVisibleEvents({ userId: req.userId, ...range, canEditGlobal, includeGlobal });

    // Дни рождения — понятие личное: в срезе пространства им не место.
    const wantsBirthdays = !filtered || req.query.scope_kind === 'personal';
    const birthdays = wantsBirthdays && req.query.birthdays !== '0'
      ? listContactBirthdays({ userId: req.userId, ...range })
      : [];

    res.json({
      events,
      birthdays,
      can_publish_global: canEditGlobal,
      // Названия и цвета дополнительных календарей едут вместе с событиями, а
      // не отдельной ручкой: слой без имени клиент показать не может, и вторым
      // запросом список приезжал бы позже событий — слой успевал бы моргнуть
      // безымянным. Тем, кто не видит общий календарь, он и не нужен.
      google_calendars: includeGlobal ? listGoogleCalendarLayers() : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/events', verifyToken, (req, res) => {
  try {
    const parsed = parseEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const scopeError = scopeWriteError(parsed.value.scope_kind, req.userId);
    if (scopeError) return res.status(403).json({ error: scopeError });

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

    const eventId = result.lastInsertRowid;
    replaceGuests(eventId, req.userId, parsed.guestIds);
    replaceReminders(eventId, parsed.reminders);

    // Приглашение, о котором не сказали, — это событие, о котором человек
    // узнает, только если сам заглянет в календарь.
    const created = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
    notifyInvited(req.app.get('io'), created, parsed.guestIds.filter((id) => id !== req.userId));

    res.status(201).json({ id: eventId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/events/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!editableEvent(id, req.userId)) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    const parsed = parseEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    // Проверяем и целевую область: иначе правкой можно было бы перенести
    // личное событие в общий календарь в обход прав.
    const scopeError = scopeWriteError(parsed.value.scope_kind, req.userId);
    if (scopeError) return res.status(403).json({ error: scopeError });

    const event = parsed.value;
    db.prepare(`
      UPDATE calendar_events
      SET scope_kind = ?, scope_id = ?, title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
          all_day = ?, color = ?, recurrence = ?, is_task = ?, updated_at = ?
      WHERE id = ?
    `).run(
      event.scope_kind, event.scope_id, event.title, event.description, event.location, event.starts_at, event.ends_at,
      event.all_day, event.color, event.recurrence, event.is_task, Date.now(), id
    );

    // Правка времени или правила смещает вхождения — старые отметки о
    // выполнении и правки отдельных вхождений привязаны к моментам, которых
    // больше нет.
    db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ?').run(id);

    // Считаем новичков до перезаписи списка, иначе все окажутся «новыми».
    const invited = newlyInvited(id, parsed.guestIds).filter((guestId) => guestId !== req.userId);
    replaceGuests(id, req.userId, parsed.guestIds);
    replaceReminders(id, parsed.reminders);

    const saved = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
    notifyInvited(req.app.get('io'), saved, invited);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/events/:id', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!editableEvent(id, req.userId)) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    // До удаления строки: привязка к Google уходит по каскаду вместе с ней, и
    // после удаления отправлять в гугл было бы уже нечего.
    recordLocalDeletion(id);

    db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_event_guests WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_event_reminders WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ?').run(id);
    db.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(id);
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
    if (!editableEvent(id, req.userId)) {
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

// ===== Одно вхождение серии =====
//
// Правка и удаление выше действуют на всю серию. Эти две ручки — про «только
// это событие»: перенести один вторник, не трогая остальные, или отменить
// одну планёрку. Ключ — место вхождения в серии (occurrence_start), а не его
// новое время: иначе повторный перенос завёл бы второе исключение вместо
// правки первого.

function parseOccurrenceStart(value) {
  const start = Number(value);
  return Number.isFinite(start) ? start : null;
}

router.put('/events/:id/occurrence', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const event = editableEvent(id, req.userId);
    if (!event) return res.status(404).json({ error: 'Событие не найдено' });
    if (!event.recurrence) {
      return res.status(400).json({ error: 'Это не повторяющееся событие' });
    }

    const occurrenceStart = parseOccurrenceStart(req.body.occurrence_start);
    if (occurrenceStart === null) return res.status(400).json({ error: 'Некорректное вхождение' });

    const parsed = parseEventBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const value = parsed.value;
    db.prepare(`
      INSERT INTO calendar_event_exceptions
        (event_id, occurrence_start, kind, title, description, location, starts_at, ends_at, all_day, color)
      VALUES (?, ?, 'override', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, occurrence_start) DO UPDATE SET
        kind = 'override',
        title = excluded.title,
        description = excluded.description,
        location = excluded.location,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        all_day = excluded.all_day,
        color = excluded.color
    `).run(
      id, occurrenceStart, value.title, value.description, value.location,
      value.starts_at, value.ends_at, value.all_day, value.color
    );

    // Время вхождения изменилось — напоминания по нему нужно отправить заново.
    db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ? AND occurrence_start = ?')
      .run(id, occurrenceStart);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/events/:id/occurrence', verifyToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const event = editableEvent(id, req.userId);
    if (!event) return res.status(404).json({ error: 'Событие не найдено' });
    if (!event.recurrence) {
      return res.status(400).json({ error: 'Это не повторяющееся событие' });
    }

    const occurrenceStart = parseOccurrenceStart(req.query.occurrence_start);
    if (occurrenceStart === null) return res.status(400).json({ error: 'Некорректное вхождение' });

    db.prepare(`
      INSERT INTO calendar_event_exceptions (event_id, occurrence_start, kind)
      VALUES (?, ?, 'skip')
      ON CONFLICT(event_id, occurrence_start) DO UPDATE SET
        kind = 'skip', title = NULL, description = NULL, location = NULL,
        starts_at = NULL, ends_at = NULL, all_day = NULL, color = NULL
    `).run(id, occurrenceStart);

    db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ? AND occurrence_start = ?')
      .run(id, occurrenceStart);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
