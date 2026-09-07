// Синхронизация с Google Календарём.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
  // ===== Синхронизация с Google Календарём =====
  //
  // Подключённый гугл-аккаунт. Пока он один на организацию и синхронизируется с
  // общим календарём, но user_id заложен сразу: персональные подключения — это
  // те же строки с чужим владельцем, и добавлять колонку задним числом пришлось
  // бы вместе с миграцией уже накопленных привязок.
  //
  // 0, а не NULL, для «аккаунт организации» намеренно: в UNIQUE-индексе SQLite
  // значения NULL считаются различными, и второй такой же аккаунт спокойно
  // завёлся бы рядом с первым. Внешнего ключа на users поэтому нет.
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_calendar_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      google_email TEXT,
      -- Токены лежат зашифрованными (см. services/googleOAuth.js): refresh_token
      -- — это бессрочный доступ к чужому гугл-аккаунту, и в файле базы, который
      -- попадает в бэкапы, ему нельзя лежать открытым текстом.
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at INTEGER,
      -- Какой именно календарь аккаунта синхронизируем. У человека их обычно
      -- несколько, и «primary» почти никогда не тот, который нужен организации.
      calendar_id TEXT,
      calendar_name TEXT,
      -- От чьего имени заводить импортированные события: calendar_events.owner_id
      -- ссылается на users и пустым быть не может, а супер-админ панели — это
      -- отдельная сущность (super_admins), и его id туда не подставить.
      owner_user_id INTEGER,
      -- Курсор инкрементальной выборки Google. Пусто — значит следующий проход
      -- полный (первый запуск либо курсор протух, см. 410 в googleCalendarSync).
      sync_token TEXT,
      -- Раньше этого момента чужие события не импортируем: в календаре может
      -- лежать десятилетний архив, и тащить его целиком незачем.
      sync_from INTEGER,
      last_sync_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id)
    );

    -- Связь нашего события с гугловым, одна к одному.
    CREATE TABLE IF NOT EXISTS google_calendar_links (
      event_id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      google_calendar_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      -- Что мы в последний раз видели на той стороне. По этим двум полям
      -- отличается «прилетело эхо нашей же правки» от настоящего чужого
      -- изменения — без них двусторонняя синхронизация зациклилась бы.
      remote_updated_at INTEGER,
      remote_etag TEXT,
      -- calendar_events.updated_at на момент последней успешной отправки.
      -- Стало больше — значит событие правили у нас и его пора отправить.
      local_synced_at INTEGER,
      -- Правило повтора, которое наша модель выразить не умеет (BYDAY и прочее).
      -- Такое событие мы читаем, но обратно не отправляем НИКОГДА: отправить
      -- значило бы переписать в гугле нашим упрощённым правилом то, что мы
      -- сами же не смогли прочитать целиком.
      push_blocked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(google_calendar_id, google_event_id),
      FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
    );

    -- Надгробия удалённых событий. Наше удаление физически сносит строку, а
    -- вместе с ней по каскаду и привязку, — и отправлять в гугл после этого
    -- стало бы нечего. Поэтому удаление сначала пишет сюда, а разносит его
    -- следующий проход синхронизации.
    CREATE TABLE IF NOT EXISTS google_calendar_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      google_calendar_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(google_calendar_id, google_event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_google_links_account ON google_calendar_links(account_id);
  `);

  // Есть ли у нас право писать в выбранный календарь. Чужой календарь, на который
  // аккаунт лишь подписан, доступен только на чтение — такой синхронизируется в
  // одну сторону, и пытаться отправить туда наши правки значило бы получать 403
  // на каждом проходе.
  //
  // Признак не задаётся руками и не приходит от клиента: его перечитывает каждый
  // проход синхронизации у самого Google. Иначе выданное позже право записи
  // пришлось бы замечать вручную, а до тех пор обмен молча оставался бы
  // односторонним.
  try {
    db.exec('ALTER TABLE google_calendar_accounts ADD COLUMN calendar_read_only INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    // Колонка уже есть
  }

  // Календари, которые мы читаем. Их несколько, ровно как в самом Google, где
  // рядом с собственным календарём аккаунта живут «Другие календари» — чужие,
  // подписанные, доступные только на чтение.
  //
  // Основной календарь (google_calendar_accounts.calendar_id) — тоже строка
  // здесь, с is_main = 1: пайплайн чтения у всех один, и держать для него
  // отдельную ветку кода значило бы чинить каждую ошибку дважды. Отличается он
  // ровно двумя вещами — в него уходят НАШИ события, и его содержимое ложится в
  // общий календарь, тогда как дополнительные получают каждый свой слой.
  //
  // Курсор у каждого календаря свой: инкрементальная выборка Google выдаётся на
  // календарь, и один общий sync_token означал бы, что чтение второго календаря
  // сбрасывает позицию первого.
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_calendar_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      google_calendar_id TEXT NOT NULL,
      name TEXT,
      -- Права на момент последнего прохода: их перечитывает сама синхронизация,
      -- потому что доступ могут выдать или отобрать не спросив нас.
      access_role TEXT,
      read_only INTEGER NOT NULL DEFAULT 1,
      is_main INTEGER NOT NULL DEFAULT 0,
      -- Цвет слоя в календаре чата. У дополнительного календаря он свой, иначе
      -- в сетке их было бы не отличить друг от друга и от общего.
      color TEXT NOT NULL DEFAULT 'violet',
      sync_token TEXT,
      last_sync_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(account_id, google_calendar_id)
    );

    CREATE INDEX IF NOT EXISTS idx_google_sources_account ON google_calendar_sources(account_id);
  `);

  // Перенос уже подключённого календаря в новую таблицу. Аккаунт на проде завели
  // до её появления, и без этого его календарь перестал бы читаться вовсе.
  const legacyAccount = db.prepare(
    'SELECT * FROM google_calendar_accounts WHERE calendar_id IS NOT NULL'
  ).all();
  for (const account of legacyAccount) {
    const exists = db.prepare(
      'SELECT 1 FROM google_calendar_sources WHERE account_id = ? AND google_calendar_id = ?'
    ).get(account.id, account.calendar_id);
    if (exists) continue;
    db.prepare(`
      INSERT INTO google_calendar_sources
        (account_id, google_calendar_id, name, read_only, is_main, sync_token, last_sync_at, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      account.id, account.calendar_id, account.calendar_name,
      account.calendar_read_only ? 1 : 0,
      account.sync_token, account.last_sync_at, Date.now()
    );
  }
};
