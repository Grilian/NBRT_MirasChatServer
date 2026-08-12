const db = require('../db');
const { ORG_ACCOUNT, getAccount, recordError } = require('./googleOAuth');
const api = require('./googleCalendarApi');
const { toGoogleEvent, fromGoogleEvent, originalStartOf, ourEventId } = require('./googleCalendarMap');

// Двусторонняя синхронизация общего календаря с Google.
//
// Состояние целиком в базе, как и у планировщика напоминаний: перезапуск pm2
// случается при каждой выкладке, и всё, что жило бы в памяти, терялось бы
// вместе с ним. Курсор Google (sync_token) — тоже часть этого состояния.
//
// Порядок внутри прохода — сначала отправка, потом чтение. Наоборот было бы
// хуже: только что прочитанное мы бы тут же отправили обратно как «изменённое
// у нас», и каждая правка гуляла бы по кругу.

const TICK_MS = 5 * 60 * 1000;

// Первый проход после подключения делаем не сразу: сервер только поднялся, и
// упереться в сеть на старте — не то, чем стоит занимать запуск.
const FIRST_TICK_DELAY_MS = 30 * 1000;

// Синхронизируется общий календарь: у гуглового аккаунта организации нет
// понятия «личное событие сотрудника», и подставлять туда чужие личные
// встречи означало бы раздать их всем, у кого есть доступ к тому календарю.
const SYNCED_SCOPE = 'global';

// Потолок страниц за проход. Первый проход по большому календарю может быть
// длинным, но бесконечным — только при испорченном nextPageToken.
const MAX_PAGES = 40;

let running = false;

// ===== Вспомогательное =====

const linkByEvent = db.prepare('SELECT * FROM google_calendar_links WHERE event_id = ?');
const linkByGoogle = db.prepare(
  'SELECT * FROM google_calendar_links WHERE google_calendar_id = ? AND google_event_id = ?'
);

const upsertLink = db.prepare(`
  INSERT INTO google_calendar_links
    (event_id, account_id, google_calendar_id, google_event_id,
     remote_updated_at, remote_etag, local_synced_at, push_blocked)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id) DO UPDATE SET
    account_id = excluded.account_id,
    google_calendar_id = excluded.google_calendar_id,
    google_event_id = excluded.google_event_id,
    remote_updated_at = excluded.remote_updated_at,
    remote_etag = excluded.remote_etag,
    local_synced_at = excluded.local_synced_at,
    push_blocked = excluded.push_blocked
`);

/**
 * Запомнить, что событие удалили у нас.
 *
 * Вызывается ДО удаления строки: привязка уходит по каскаду вместе с событием,
 * и после удаления отправлять в гугл было бы уже нечего. Разносит надгробия
 * следующий проход — держать сеть внутри обработчика запроса нельзя.
 */
function recordLocalDeletion(eventId) {
  const link = linkByEvent.get(eventId);
  if (!link) return;

  // В календарь, доступный только на чтение, удаление отправить нельзя. Копить
  // такие надгробия в расчёте на будущее право записи нельзя тем более: они
  // разъехались бы разом в день его выдачи и снесли бы в чужом календаре
  // события, которые никто не собирался удалять оттуда — у нас это в тот момент
  // значило «убрать из зеркала», а не «удалить у всех».
  const source = db.prepare(
    'SELECT read_only FROM google_calendar_sources WHERE account_id = ? AND google_calendar_id = ?'
  ).get(link.account_id, link.google_calendar_id);
  if (!source || source.read_only) return;

  db.prepare(`
    INSERT OR IGNORE INTO google_calendar_deletions
      (account_id, google_calendar_id, google_event_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(link.account_id, link.google_calendar_id, link.google_event_id, Date.now());
}

/**
 * Аккаунт, с которым есть что синхронизировать. null — нечего или не настроено.
 *
 * Календарь тут уже не обязателен: дополнительные читаются и без выбранного
 * основного. Без автора импортированных событий — по-прежнему нельзя, у нашего
 * события owner_id пустым быть не может.
 */
function syncableAccount(userId = ORG_ACCOUNT) {
  const account = getAccount(userId);
  if (!account || !account.owner_user_id) return null;
  if (!listSources(account.id).length) return null;
  return account;
}

const listSources = (accountId) => db.prepare(
  'SELECT * FROM google_calendar_sources WHERE account_id = ? ORDER BY is_main DESC, id'
).all(accountId);

/** Календарь, в который уезжают НАШИ события. null — такого нет или он на чтение. */
function writableMain(accountId) {
  const main = db.prepare(
    'SELECT * FROM google_calendar_sources WHERE account_id = ? AND is_main = 1'
  ).get(accountId);
  return main && !main.read_only ? main : null;
}

/**
 * Куда в нашем календаре ложится содержимое этого календаря Google.
 *
 * Основной — в общий календарь: он и есть календарь организации. Остальные —
 * каждый в свой слой, как «Другие календари» в самом Google; свалив их в общий,
 * мы лишили бы человека возможности выключить чужие мероприятия, не выключая
 * события организации.
 */
const scopeOf = (source) => (source.is_main
  ? { kind: SYNCED_SCOPE, id: null }
  : { kind: 'gcal', id: source.id });

// ===== Отправка наших изменений =====

async function pushDeletions(account, main) {
  const rows = db.prepare(`
    SELECT * FROM google_calendar_deletions
    WHERE account_id = ? AND google_calendar_id = ? ORDER BY id LIMIT 200
  `).all(account.id, main.google_calendar_id);

  let count = 0;
  for (const row of rows) {
    await api.deleteEvent(account, row.google_calendar_id, row.google_event_id);
    // Снимаем надгробие только после успеха: на ошибке проход прервётся, и
    // удаление доедет следующим — потерять его нельзя, второго повода не будет.
    db.prepare('DELETE FROM google_calendar_deletions WHERE id = ?').run(row.id);
    count += 1;
  }
  return count;
}

async function pushEvents(account, main) {
  // Новые (привязки нет) и изменённые после последней отправки. Одним
  // запросом, потому что различаются они только наличием строки в links.
  //
  // Берётся только общий календарь: события слоёв 'gcal' — зеркало чужих
  // календарей, и отправлять их куда-либо значило бы копировать чужие
  // мероприятия в календарь организации.
  const rows = db.prepare(`
    SELECT e.*, l.google_event_id, l.local_synced_at, l.push_blocked
    FROM calendar_events e
    LEFT JOIN google_calendar_links l ON l.event_id = e.id
    WHERE e.scope_kind = ?
      AND (l.event_id IS NULL OR (l.push_blocked = 0 AND e.updated_at > l.local_synced_at))
  `).all(SYNCED_SCOPE);

  let count = 0;
  for (const event of rows) {
    const body = toGoogleEvent(event);
    const saved = event.google_event_id
      ? await api.patchEvent(account, main.google_calendar_id, event.google_event_id, body)
      : await api.insertEvent(account, main.google_calendar_id, body);

    upsertLink.run(
      event.id, account.id, main.google_calendar_id, saved.id,
      Date.parse(saved.updated) || Date.now(), saved.etag || null,
      // Именно updated_at события, а не «сейчас»: между выборкой и ответом
      // Google его могли успеть поправить снова, и «сейчас» проглотило бы ту
      // правку — она никогда не уехала бы в гугл.
      event.updated_at, 0
    );
    count += 1;
  }
  return count;
}

// ===== Чтение чужих изменений =====

const insertEvent = db.prepare(`
  INSERT INTO calendar_events
    (owner_id, scope_kind, scope_id, title, description, location,
     starts_at, ends_at, all_day, color, recurrence, is_task, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateEvent = db.prepare(`
  UPDATE calendar_events
  SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
      all_day = ?, color = ?, recurrence = ?, updated_at = ?
  WHERE id = ?
`);

/**
 * Применить пришедшее из гугла событие-серию (или одиночное).
 *
 * Возвращает true, если что-то действительно изменилось. Именно факт
 * изменения, а не «строку разобрали»: инкрементальная выборка при первом же
 * проходе после нашей же отправки возвращает наши собственные события, и
 * считать их изменениями значило бы дёргать клиентов на каждом тике.
 */
function applyRemoteMaster(account, source, item) {
  const link = linkByGoogle.get(source.google_calendar_id, item.id);
  const scope = scopeOf(source);

  if (item.status === 'cancelled') {
    // Удалили у них — удаляем у себя. Привязка уходит по каскаду, и надгробие
    // заводить не надо: в гугле события уже нет.
    if (!link) return false;
    deleteLocalEvent(link.event_id);
    return true;
  }

  const parsed = fromGoogleEvent(item);
  if (!parsed) return false;

  const remoteUpdated = Date.parse(item.updated) || Date.now();
  const fields = parsed.fields;

  if (link) {
    // Ровно то, что мы сами туда и записали, — эхо нашей же отправки.
    if (link.remote_updated_at && remoteUpdated <= link.remote_updated_at) return false;

    const local = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(link.event_id);
    if (!local) return false;

    // Правили с обеих сторон — побеждает более позднее изменение. Отправка
    // идёт до чтения, поэтому сюда попадает только правка, случившаяся прямо
    // во время прохода; молча затирать её более старой чужой нельзя.
    //
    // Для календаря, доступного только на чтение, этого спора не существует:
    // наша правка туда не уедет никогда, и оставить её значило бы навсегда
    // заморозить событие в состоянии, которого на той стороне нет.
    if (!source.read_only
      && local.updated_at > link.local_synced_at && local.updated_at > remoteUpdated) {
      return false;
    }

    const now = Date.now();
    updateEvent.run(
      fields.title, fields.description, fields.location, fields.starts_at,
      fields.ends_at, fields.all_day,
      source.is_main ? fields.color : source.color,
      fields.recurrence, now, link.event_id
    );
    // Время и правило могли сдвинуться — вхождения, к которым привязаны
    // отметки и напоминания, уехали. Ровно как при правке через наш API.
    resetOccurrenceState(link.event_id);
    applyRemoteSkips(link.event_id, parsed.skips);

    upsertLink.run(
      link.event_id, account.id, source.google_calendar_id, item.id,
      remoteUpdated, item.etag || null,
      // Мы только что подняли updated_at до now. Не отметив это здесь,
      // следующая же отправка сочла бы событие изменённым у нас и отправила
      // обратно то, что сама только что прочитала.
      now, parsed.supported ? 0 : 1
    );
    return true;
  }

  // Привязки нет. Возможно, событие наше, а привязки лишились: базу подняли
  // из бэкапа либо аккаунт переподключили. Метку в гугле мы ставим сами
  // (extendedProperties), по ней связь и восстанавливается — иначе получили бы
  // второй экземпляр каждого своего события.
  const claimed = ourEventId(item);
  if (claimed) {
    const existing = db.prepare(
      'SELECT * FROM calendar_events WHERE id = ? AND scope_kind = ?'
    ).get(claimed, scope.kind);
    if (existing && !linkByEvent.get(existing.id)) {
      upsertLink.run(
        existing.id, account.id, source.google_calendar_id, item.id,
        remoteUpdated, item.etag || null, existing.updated_at, parsed.supported ? 0 : 1
      );
      // Связь восстановили, содержимое не трогали — показывать нечего.
      return false;
    }
  }

  const now = Date.now();
  const result = insertEvent.run(
    account.owner_user_id, scope.kind, scope.id,
    fields.title, fields.description, fields.location, fields.starts_at,
    fields.ends_at, fields.all_day,
    // Цвет слоя, а не тот, что стоит у события в Google: дополнительный
    // календарь узнаётся в сетке именно по цвету, и разноцветные мероприятия
    // внутри него сделали бы слой неотличимым от остальных.
    source.is_main ? fields.color : source.color,
    fields.recurrence, fields.is_task,
    now, now
  );
  const eventId = Number(result.lastInsertRowid);
  applyRemoteSkips(eventId, parsed.skips);
  upsertLink.run(
    eventId, account.id, source.google_calendar_id, item.id,
    remoteUpdated, item.etag || null, now, parsed.supported ? 0 : 1
  );
  return true;
}

/**
 * Отдельное вхождение серии: перенесённое, переименованное или отменённое.
 *
 * Ложится на наши calendar_event_exceptions один в один — ключом служит
 * originalStartTime, то есть место вхождения в серии, а не его новое время.
 * Ровно тот же ключ, что и у правки вхождения через наш API.
 */
function applyRemoteInstance(account, source, item) {
  const link = linkByGoogle.get(source.google_calendar_id, item.recurringEventId);
  if (!link) return false;

  const slot = originalStartOf(item);
  if (slot === null) return false;

  if (item.status === 'cancelled') {
    db.prepare(`
      INSERT INTO calendar_event_exceptions (event_id, occurrence_start, kind)
      VALUES (?, ?, 'skip')
      ON CONFLICT(event_id, occurrence_start) DO UPDATE SET
        kind = 'skip', title = NULL, description = NULL, location = NULL,
        starts_at = NULL, ends_at = NULL, all_day = NULL, color = NULL
    `).run(link.event_id, slot);
    db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ? AND occurrence_start = ?')
      .run(link.event_id, slot);
    return true;
  }

  const parsed = fromGoogleEvent(item);
  if (!parsed) return false;
  const f = parsed.fields;

  db.prepare(`
    INSERT INTO calendar_event_exceptions
      (event_id, occurrence_start, kind, title, description, location, starts_at, ends_at, all_day, color)
    VALUES (?, ?, 'override', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, occurrence_start) DO UPDATE SET
      kind = 'override',
      title = excluded.title, description = excluded.description, location = excluded.location,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at,
      all_day = excluded.all_day, color = excluded.color
  `).run(
    link.event_id, slot, f.title, f.description, f.location,
    f.starts_at, f.ends_at, f.all_day, f.color
  );
  db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ? AND occurrence_start = ?')
    .run(link.event_id, slot);
  return true;
}

/**
 * Пропуски серии, заданные строкой EXDATE в самом событии.
 *
 * Google обычно отменяет вхождение отдельной строкой (status: 'cancelled' с
 * recurringEventId) — её разбирает applyRemoteInstance. Но событие, приехавшее
 * в календарь из ICS-подписки или перенесённое из другого приложения, несёт
 * отмены прямо в EXDATE, и без разбора здесь такие вхождения показывались бы
 * как живые.
 *
 * INSERT OR IGNORE, а не перезапись: EXDATE приходит в каждом ответе целиком, и
 * переписывать по нему исключения на каждом проходе значило бы раз за разом
 * затирать точечные правки вхождений, приехавшие отдельными строками.
 */
const insertSkip = db.prepare(`
  INSERT OR IGNORE INTO calendar_event_exceptions (event_id, occurrence_start, kind)
  VALUES (?, ?, 'skip')
`);

function applyRemoteSkips(eventId, skips) {
  if (!skips || !skips.length) return;
  for (const slot of skips) {
    const result = insertSkip.run(eventId, slot);
    // Вхождения больше нет — отметки о выполнении и отправленные напоминания
    // относятся к тому, чего не существует. Только при настоящей вставке:
    // иначе каждый проход стирал бы их заново.
    if (result.changes) {
      db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ? AND occurrence_start = ?')
        .run(eventId, slot);
      db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ? AND occurrence_start = ?')
        .run(eventId, slot);
    }
  }
}

function resetOccurrenceState(eventId) {
  db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ?').run(eventId);
}

function deleteLocalEvent(eventId) {
  db.prepare('DELETE FROM calendar_task_completions WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM calendar_event_guests WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM calendar_event_reminders WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM calendar_reminders_sent WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
}

/**
 * Разбор страницы. Серии — первым проходом, вхождения — вторым: вхождение
 * ссылается на свою серию, а порядок в ответе Google не обещан, и на первой же
 * новой серии её правка потерялась бы, не найдя привязки.
 */
function applyPage(account, source, items) {
  let changed = 0;

  for (const item of items) {
    if (item.recurringEventId) continue;
    if (applyRemoteMaster(account, source, item)) changed += 1;
  }

  for (const item of items) {
    if (!item.recurringEventId) continue;
    if (applyRemoteInstance(account, source, item)) changed += 1;
  }

  return changed;
}

/** Чтение одного календаря. Курсор у каждого свой — см. таблицу источников. */
async function pullSource(account, source) {
  let syncToken = source.sync_token || null;
  let usedFullResync = false;
  let changed = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let pageToken = null;
    changed = 0;

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const data = await api.listEvents(account, source.google_calendar_id, {
          syncToken,
          timeMin: account.sync_from || Date.now() - 30 * 24 * 60 * 60 * 1000,
          pageToken,
        });

        changed += applyPage(account, source, data.items || []);

        if (data.nextSyncToken) {
          db.prepare('UPDATE google_calendar_sources SET sync_token = ? WHERE id = ?')
            .run(data.nextSyncToken, source.id);
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return { changed, fullResync: usedFullResync };
    } catch (e) {
      // 410 — курсор протух (Google хранит их ограниченное время). Это штатный
      // ответ, а не поломка: начинаем проход заново без курсора.
      if (e instanceof api.GoogleApiError && e.status === 410 && syncToken) {
        db.prepare('UPDATE google_calendar_sources SET sync_token = NULL WHERE id = ?').run(source.id);
        syncToken = null;
        usedFullResync = true;
        continue;
      }
      throw e;
    }
  }

  return { changed, fullResync: usedFullResync };
}

/**
 * Перечитать права на календарь у самого Google.
 *
 * Делается каждый проход: право записи могут выдать когда угодно и не сказав
 * нам. Без этого календарь, подключённый на чтение, остался бы односторонним
 * навсегда — до тех пор, пока человек не вспомнит и не переподключит его
 * руками. Ошибку опроса глотаем: остаться при прежнем знании о правах лучше,
 * чем не прочитать календарь вовсе.
 */
async function refreshAccess(account, source) {
  try {
    const access = await api.getCalendarAccess(account, source.google_calendar_id);
    if (!access) return source;
    const readOnly = access.writable ? 0 : 1;
    if (readOnly === source.read_only && access.access_role === source.access_role) return source;
    db.prepare('UPDATE google_calendar_sources SET read_only = ?, access_role = ? WHERE id = ?')
      .run(readOnly, access.access_role, source.id);
    return { ...source, read_only: readOnly, access_role: access.access_role };
  } catch {
    return source;
  }
}

// ===== Проход целиком =====

/**
 * Один полный проход синхронизации.
 *
 * Возвращает сводку — её показывает панель после кнопки «Синхронизировать
 * сейчас» и пишет в лог планировщик.
 */
async function runSync(io, { userId = ORG_ACCOUNT } = {}) {
  const account = syncableAccount(userId);
  if (!account) return { skipped: true, reason: 'Аккаунт не подключён или не выбран календарь' };

  if (running) return { skipped: true, reason: 'Синхронизация уже идёт' };
  running = true;

  try {
    // Права перечитываем до всего остального: от них зависит, отправлять ли
    // вообще, а выданное вчера право записи должно включить обмен само.
    const sources = [];
    for (const source of listSources(account.id)) {
      sources.push(await refreshAccess(account, source));
    }

    // Отправка — только в основной календарь и только если в него можно писать.
    const main = writableMain(account.id);
    const deleted = main ? await pushDeletions(account, main) : 0;
    const pushed = main ? await pushEvents(account, main) : 0;

    let pulled = 0;
    let fullResync = false;
    for (const source of sources) {
      // Один недоступный календарь не должен останавливать остальные: доступ к
      // чужому могут отозвать в любой момент, и это не повод перестать читать
      // собственный. Ошибка запоминается у самого календаря.
      try {
        const result = await pullSource(account, source);
        pulled += result.changed;
        fullResync = fullResync || result.fullResync;
        db.prepare(
          'UPDATE google_calendar_sources SET last_sync_at = ?, last_error = NULL WHERE id = ?'
        ).run(Date.now(), source.id);
      } catch (e) {
        db.prepare('UPDATE google_calendar_sources SET last_error = ? WHERE id = ?')
          .run(String(e.message || e).slice(0, 500), source.id);
      }
    }

    db.prepare(
      'UPDATE google_calendar_accounts SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?'
    ).run(Date.now(), Date.now(), account.id);

    // Календарь у клиентов перечитывается по смене диапазона, и без сигнала
    // импортированное появлялось бы только после перелистывания месяца.
    if (io && (pulled || pushed || deleted)) io.emit('calendar_changed');

    return { ok: true, pushed, deleted, pulled, fullResync, readonly: !main };
  } catch (e) {
    const message = e && e.message ? e.message : 'Неизвестная ошибка';
    recordError(account.id, message);
    console.error('[google-календарь] ошибка синхронизации:', message);
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

function start(io) {
  const tick = () => { runSync(io).catch(() => {}); };

  const first = setTimeout(tick, FIRST_TICK_DELAY_MS);
  first.unref();

  // unref по той же причине, что и у планировщика напоминаний: держать процесс
  // живым должен http-сервер, иначе node не завершился бы по Ctrl+C.
  const timer = setInterval(tick, TICK_MS);
  timer.unref();

  console.log('[google-календарь] синхронизация запущена');
  return timer;
}

module.exports = {
  SYNCED_SCOPE,
  start,
  runSync,
  recordLocalDeletion,
  syncableAccount,
  listSources,
  scopeOf,
  applyRemoteMaster,
  applyRemoteInstance,
  applyPage,
};
