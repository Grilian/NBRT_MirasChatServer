const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `miras-google-calendar-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_DB_PATH = dbPath;
process.env.SUPERADMIN_USERNAME = `google_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'google-test-password';
process.env.GOOGLE_TOKEN_KEY = 'google-calendar-test-key';

const db = require('../db');
const map = require('../services/googleCalendarMap');
const oauth = require('../services/googleOAuth');
const sync = require('../services/googleCalendarSync');
const { moscowInstant, moscowDayKey } = require('../utils/moscowTime');

test.after(() => {
  try { fs.unlinkSync(dbPath); } catch { /* временный файл, уже мог исчезнуть */ }
});

// ===== Время =====

test('событие на весь день переживает круг туда-обратно', () => {
  const event = {
    all_day: 1,
    starts_at: moscowInstant('2026-08-12', 0),
    ends_at: moscowInstant('2026-08-12', 24 * 60) - 60000,
  };

  const google = map.toGoogleTimes(event);
  // Граница у Google исключающая: однодневное событие кончается следующим днём.
  assert.equal(google.start.date, '2026-08-12');
  assert.equal(google.end.date, '2026-08-13');

  const back = map.fromGoogleTimes(google);
  assert.equal(back.all_day, 1);
  assert.equal(back.starts_at, event.starts_at);
  assert.equal(back.ends_at, event.ends_at);
});

test('многодневное событие на весь день не теряет последний день', () => {
  const back = map.fromGoogleTimes({ start: { date: '2026-08-10' }, end: { date: '2026-08-13' } });
  assert.equal(moscowDayKey(back.starts_at), '2026-08-10');
  assert.equal(moscowDayKey(back.ends_at), '2026-08-12');
});

test('событие со временем переживает круг туда-обратно', () => {
  const starts = moscowInstant('2026-08-12', 14 * 60);
  const event = { all_day: 0, starts_at: starts, ends_at: starts + 90 * 60000 };

  const google = map.toGoogleTimes(event);
  assert.equal(google.start.timeZone, 'Europe/Moscow');

  const back = map.fromGoogleTimes(google);
  assert.equal(back.all_day, 0);
  assert.equal(back.starts_at, event.starts_at);
  assert.equal(back.ends_at, event.ends_at);
});

// ===== Правило повтора =====

test('наше правило превращается в RRULE', () => {
  const lines = map.toGoogleRecurrence({
    all_day: 0,
    starts_at: moscowInstant('2026-08-12', 10 * 60),
    recurrence: JSON.stringify({ freq: 'weekly', interval: 2, until: null }),
  });
  assert.deepEqual(lines, ['RRULE:FREQ=WEEKLY;INTERVAL=2']);
});

test('RRULE с избыточным BYDAY считается переводимым', () => {
  // 12 августа 2026 — среда. Google дописывает BYDAY=WE к обычному «каждую
  // среду»: ограничения это не добавляет, и отказываться от такого правила
  // значило бы записать в «только чтение» половину обычных встреч.
  const starts = moscowInstant('2026-08-12', 10 * 60);
  const parsed = map.parseRRule('RRULE:FREQ=WEEKLY;BYDAY=WE', starts, 0);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.rule.freq, 'weekly');
});

test('BYDAY, не совпадающий с днём события, делает правило непереводимым', () => {
  const starts = moscowInstant('2026-08-12', 10 * 60);
  assert.equal(map.parseRRule('RRULE:FREQ=WEEKLY;BYDAY=MO,TH', starts, 0).supported, false);
  // «Второй вторник месяца» нашей моделью не выражается даже одним днём.
  assert.equal(map.parseRRule('RRULE:FREQ=MONTHLY;BYDAY=2TU', starts, 0).supported, false);
  assert.equal(map.parseRRule('RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR', starts, 0).supported, false);
});

test('COUNT превращается в дату окончания, охватывающую нужное число повторов', () => {
  const starts = moscowInstant('2026-08-12', 10 * 60);
  const until = map.untilFromCount(starts, { freq: 'daily', interval: 1 }, 3);
  // Третье вхождение — 14 августа; предел должен быть позже него, но раньше
  // четвёртого, иначе серия либо оборвётся рано, либо захватит лишнее.
  assert.ok(until > moscowInstant('2026-08-14', 10 * 60));
  assert.ok(until < moscowInstant('2026-08-15', 10 * 60));
});

test('UNTIL читается и из даты, и из метки UTC', () => {
  const starts = moscowInstant('2026-08-12', 10 * 60);
  const byDate = map.parseRRule('RRULE:FREQ=DAILY;UNTIL=20260820', starts, 1);
  // Дата без времени — это весь день целиком, иначе последнее вхождение серии
  // срезалось бы как «позже предела».
  assert.equal(byDate.rule.until, moscowInstant('2026-08-20', 24 * 60));

  const byStamp = map.parseRRule('RRULE:FREQ=DAILY;UNTIL=20260820T090000Z', starts, 0);
  assert.equal(byStamp.rule.until, Date.parse('2026-08-20T09:00:00Z'));
});

test('RDATE и второе RRULE помечают событие как непереводимое', () => {
  const starts = moscowInstant('2026-08-12', 10 * 60);
  const withRdate = map.fromGoogleRecurrence(
    ['RRULE:FREQ=WEEKLY', 'RDATE;VALUE=DATE:20260901'], starts, 0
  );
  assert.equal(withRdate.supported, false);

  const twoRules = map.fromGoogleRecurrence(
    ['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=MONTHLY'], starts, 0
  );
  assert.equal(twoRules.supported, false);
});

test('EXDATE отдаётся отдельным списком пропусков', () => {
  const starts = moscowInstant('2026-08-12', 10 * 60);
  const parsed = map.fromGoogleRecurrence(
    ['RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20260814,20260815'], starts, 1
  );
  assert.equal(parsed.skips.length, 2);
  // Дата без времени в EXDATE указывает на само вхождение, а оно стоит на
  // начале дня. Взяв конец дня (как у UNTIL), мы не попали бы ключом ни в одно
  // исключение, и пропуск потерялся бы молча.
  assert.deepEqual(parsed.skips, [
    moscowInstant('2026-08-14', 0),
    moscowInstant('2026-08-15', 0),
  ]);
});

// ===== Событие целиком =====

test('событие без названия получает подпись вместо пустоты', () => {
  const parsed = map.fromGoogleEvent({
    start: { dateTime: '2026-08-12T10:00:00Z' },
    end: { dateTime: '2026-08-12T11:00:00Z' },
  });
  assert.equal(parsed.fields.title, 'Без названия');
  assert.equal(parsed.fields.is_task, 0);
});

test('наша метка позволяет узнать собственное событие', () => {
  const body = map.toGoogleEvent({
    id: 42, title: 'Планёрка', all_day: 0,
    starts_at: Date.now(), ends_at: Date.now() + 3600000,
    color: 'green', recurrence: null,
  });
  assert.equal(body.extendedProperties.private[map.EVENT_ID_PROPERTY], '42');
  assert.equal(map.ourEventId(body), 42);
  assert.equal(map.ourEventId({}), null);
});

// ===== Хранение токенов =====

test('токен шифруется и читается обратно, а мусор не роняет чтение', () => {
  const stored = oauth.encryptToken('1//refresh-token-value');
  assert.notEqual(stored, '1//refresh-token-value');
  assert.equal(oauth.decryptToken(stored), '1//refresh-token-value');
  // Сменили ключ, подсунули чужую базу, испортили строку — всё это должно
  // читаться как «нет доступа», а не падать.
  assert.equal(oauth.decryptToken('v1:zzz:zzz:zzz'), null);
  assert.equal(oauth.decryptToken('не наш формат'), null);
  assert.equal(oauth.decryptToken(null), null);
});

test('одноразовый state гасится и повторно не проходит', () => {
  const state = oauth.issueState(1);
  assert.equal(oauth.consumeState(state), true);
  assert.equal(oauth.consumeState(state), false);
  assert.equal(oauth.consumeState('подделка'), false);
});

// ===== Разбор ответа Google =====

// user_id у аккаунта уникален — это и есть правило «один аккаунт организации».
// Тестам нужно несколько независимых, поэтому каждый заводится своим номером:
// боевой аккаунт организации всегда 0, здесь номер значения не имеет.
let accountSeq = 0;

function makeAccount() {
  accountSeq += 1;
  const ownerId = Number(db.prepare(
    'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
  ).run(`google_owner_${accountSeq}`, 'x', 'Владелец').lastInsertRowid);

  const now = Date.now();
  const id = Number(db.prepare(`
    INSERT INTO google_calendar_accounts
      (user_id, calendar_id, owner_user_id, sync_from, created_at, updated_at)
    VALUES (?, 'primary', ?, ?, ?, ?)
  `).run(accountSeq, ownerId, now - 86400000, now, now).lastInsertRowid);

  return db.prepare('SELECT * FROM google_calendar_accounts WHERE id = ?').get(id);
}

test('чужое событие импортируется, правится и удаляется', () => {
  const account = makeAccount();

  const item = {
    id: 'g-event-1',
    status: 'confirmed',
    updated: '2026-08-12T09:00:00.000Z',
    etag: '"1"',
    summary: 'Совещание',
    start: { dateTime: '2026-08-12T10:00:00Z' },
    end: { dateTime: '2026-08-12T11:00:00Z' },
  };

  assert.equal(sync.applyRemoteMaster(account, item), true);
  const link = db.prepare(
    'SELECT * FROM google_calendar_links WHERE google_event_id = ?'
  ).get('g-event-1');
  assert.ok(link);

  const stored = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(link.event_id);
  assert.equal(stored.title, 'Совещание');
  assert.equal(stored.scope_kind, 'global');
  assert.equal(stored.owner_id, account.owner_user_id);

  // Повтор той же строки — эхо: менять нечего, и дёргать клиентов незачем.
  assert.equal(sync.applyRemoteMaster(account, item), false);

  // Настоящая правка на той стороне — более поздний updated.
  assert.equal(sync.applyRemoteMaster(account, {
    ...item, summary: 'Совещание перенесено', updated: '2026-08-12T09:30:00.000Z',
  }), true);
  assert.equal(
    db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(link.event_id).title,
    'Совещание перенесено'
  );

  assert.equal(sync.applyRemoteMaster(account, { id: 'g-event-1', status: 'cancelled' }), true);
  assert.equal(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(link.event_id), undefined);
});

test('непереводимое правило запрещает обратную отправку', () => {
  const account = makeAccount();
  sync.applyRemoteMaster(account, {
    id: 'g-event-hard',
    status: 'confirmed',
    updated: '2026-08-12T09:00:00.000Z',
    summary: 'Каждый второй вторник',
    start: { dateTime: '2026-08-11T10:00:00Z' },
    end: { dateTime: '2026-08-11T11:00:00Z' },
    recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=2TU'],
  });

  const link = db.prepare(
    'SELECT * FROM google_calendar_links WHERE google_event_id = ?'
  ).get('g-event-hard');
  assert.equal(link.push_blocked, 1);
});

test('отменённое вхождение серии становится пропуском, а не удалением серии', () => {
  const account = makeAccount();
  const master = {
    id: 'g-series',
    status: 'confirmed',
    updated: '2026-08-12T09:00:00.000Z',
    summary: 'Планёрка',
    start: { dateTime: '2026-08-12T07:00:00Z' },
    end: { dateTime: '2026-08-12T07:30:00Z' },
    recurrence: ['RRULE:FREQ=WEEKLY'],
  };
  const cancelled = {
    id: 'g-series_20260819T070000Z',
    status: 'cancelled',
    recurringEventId: 'g-series',
    originalStartTime: { dateTime: '2026-08-19T07:00:00Z' },
  };

  // Порядок намеренно обратный: вхождение раньше своей серии. Google порядка
  // не обещает, и разбор обязан справиться.
  sync.applyPage(account, [cancelled, master]);

  const link = db.prepare('SELECT * FROM google_calendar_links WHERE google_event_id = ?').get('g-series');
  assert.ok(link, 'серия должна была импортироваться');

  const exception = db.prepare(
    'SELECT * FROM calendar_event_exceptions WHERE event_id = ?'
  ).get(link.event_id);
  assert.equal(exception.kind, 'skip');
  assert.equal(exception.occurrence_start, Date.parse('2026-08-19T07:00:00Z'));

  // Сама серия жива: отменили одно вхождение, а не всё событие.
  assert.ok(db.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(link.event_id));
});

test('EXDATE в самой серии превращается в пропуск вхождения', () => {
  const account = makeAccount();
  // Отмена, приехавшая строкой EXDATE, а не отдельным cancelled-вхождением:
  // так приходят события из ICS-подписок и перенесённые из других приложений.
  sync.applyRemoteMaster(account, {
    id: 'g-series-exdate',
    status: 'confirmed',
    updated: '2026-08-12T09:00:00.000Z',
    summary: 'Ежедневная летучка',
    start: { dateTime: '2026-08-12T07:00:00Z' },
    end: { dateTime: '2026-08-12T07:15:00Z' },
    recurrence: ['RRULE:FREQ=DAILY', 'EXDATE:20260814T070000Z'],
  });

  const link = db.prepare(
    'SELECT * FROM google_calendar_links WHERE google_event_id = ?'
  ).get('g-series-exdate');

  const exception = db.prepare(
    'SELECT * FROM calendar_event_exceptions WHERE event_id = ?'
  ).get(link.event_id);
  assert.ok(exception, 'пропуск из EXDATE должен был завестись');
  assert.equal(exception.kind, 'skip');
  assert.equal(exception.occurrence_start, Date.parse('2026-08-14T07:00:00Z'));
});

test('удаление события оставляет надгробие для отправки в Google', () => {
  const account = makeAccount();
  sync.applyRemoteMaster(account, {
    id: 'g-event-del',
    status: 'confirmed',
    updated: '2026-08-12T09:00:00.000Z',
    summary: 'Уедет',
    start: { dateTime: '2026-08-12T10:00:00Z' },
    end: { dateTime: '2026-08-12T11:00:00Z' },
  });
  const link = db.prepare(
    'SELECT * FROM google_calendar_links WHERE google_event_id = ?'
  ).get('g-event-del');

  sync.recordLocalDeletion(link.event_id);
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(link.event_id);

  const tomb = db.prepare(
    'SELECT * FROM google_calendar_deletions WHERE google_event_id = ?'
  ).get('g-event-del');
  assert.ok(tomb, 'без надгробия удаление никогда не доехало бы до Google');
  // Привязка ушла по каскаду — ровно поэтому надгробие и пишется заранее.
  assert.equal(
    db.prepare('SELECT * FROM google_calendar_links WHERE event_id = ?').get(link.event_id),
    undefined
  );
});
