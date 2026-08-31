const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

// В тестах сервисов используем отдельную временную БД. В обычном запуске
// путь остаётся прежним, поэтому это не меняет расположение продовых данных.
const dbPath = process.env.MIRAS_DB_PATH
  ? path.resolve(process.env.MIRAS_DB_PATH)
  : path.join(__dirname, 'messenger.db');
const db = new Database(dbPath);

// Оптимизация
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('busy_timeout = 5000');

// Создаём таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT,
    file_path TEXT,
    status TEXT DEFAULT 'sent',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  -- Опрос — содержимое обычного сообщения, вынесенное в нормализованные
  -- таблицы. Сам вопрос дублируется в messages.text как безопасный fallback:
  -- клиенты до 1.6.9 покажут его обычным текстом вместо пустого пузыря.
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    creator_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    description TEXT,
    show_voter_names INTEGER NOT NULL DEFAULT 1,
    multiple_choice INTEGER NOT NULL DEFAULT 0,
    allow_add_options INTEGER NOT NULL DEFAULT 0,
    allow_change_vote INTEGER NOT NULL DEFAULT 1,
    closes_at INTEGER,
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(poll_id, position),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Выбранные варианты хранятся отдельными строками. Для одиночного опроса
  -- ограничение «только один» проверяет транзакция сервиса; для множественного
  -- та же схема естественно допускает несколько option_id на пользователя.
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, option_id, user_id),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_polls_chat ON polls(chat_id, id);
  CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);
  CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
  CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(user_id);

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, chat_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Последние открытые переписки пользователя. Это серверное состояние, а
  -- не localStorage: порядок должен совпадать в Windows и на телефоне.
  -- Сам факт открытия храним даже до первого исходящего сообщения, однако
  -- наружу такой чат попадёт только после отправки (см. recentChats.js).
  CREATE TABLE IF NOT EXISTS chat_recent_openings (
    user_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    last_opened_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    target_user_id INTEGER NOT NULL,
    comment TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, target_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (target_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Отделы. Отдельно от groups намеренно: группа — это категория с правами
  -- (на «Администрация»/«Админы» завязано право писать в режиме тишины), а
  -- отдел — место человека в структуре. Смешать их значило бы дать праву
  -- писать в тишину зависеть от того, в каком отделе человек сидит.
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS super_admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, contact_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (contact_user_id) REFERENCES users(id)
  );

  -- Токены FCM для пуш-уведомлений. UNIQUE именно по token, а не по паре
  -- с user_id: токен принадлежит установке приложения на конкретном телефоне,
  -- а не человеку. Если на том же телефоне залогинился другой сотрудник,
  -- строка должна переехать к нему, иначе пуши о новых сообщениях продолжат
  -- уходить на устройство под именем прежнего владельца.
  CREATE TABLE IF NOT EXISTS device_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL DEFAULT 'android',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

  -- Настройки, которые задаёт супер-админ и которые должны пережить
  -- перезапуск сервера. Ключ-значение, а не колонки: настройка пока одна
  -- (момент установки обновления), и таблицу под неё пришлось бы переделывать
  -- при появлении второй.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  );

  -- События календаря. Время — unix-миллисекунды, как и остальные наши метки:
  -- у SQLite CURRENT_TIMESTAMP нет зоны в строке, и для календаря такой сдвиг
  -- означал бы встречу не в тот день.
  --
  -- scope_kind/scope_id заложены сразу, хотя пока используется только
  -- 'personal': тот же календарь предстоит показывать внутри пространств, и
  -- добавлять разделение задним числом пришлось бы вместе с миграцией уже
  -- накопленных событий.
  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    scope_kind TEXT NOT NULL DEFAULT 'personal',
    scope_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT 'blue',
    -- JSON вида {"freq":"weekly","interval":1,"until":null}. Разворачивается
    -- на сервере при выборке диапазона (см. services/calendarEvents.js).
    recurrence TEXT,
    -- Задача отличается от события тем, что её можно выполнить, а не тем, как
    -- она хранится: у обеих есть момент и место в сетке. Отметка о выполнении
    -- лежит отдельно (calendar_task_completions) — у повторяющейся задачи
    -- выполнен конкретный вторник, а не вся серия.
    is_task INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  -- Участники события. Отдельной таблицей, а не списком id в колонке: по ней
  -- нужно искать («какие встречи у меня сегодня»), и ответы участников
  -- хранятся тут же.
  CREATE TABLE IF NOT EXISTS calendar_event_guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    response TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(event_id, user_id),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Какая версия приложения у кого стоит. Отдельной строкой на платформу, а не
  -- колонкой в users: один и тот же человек сидит с десктопа и с телефона, и
  -- единственная колонка показывала бы ту версию, с которой он заходил
  -- последней, — то есть ровно не то, что нужно при раскатке.
  --
  -- Клиенты старше этой версии сюда не пишут вовсе: строки просто нет, и панель
  -- показывает «old». Отличить «старая сборка» от «ни разу не заходил» нельзя,
  -- да и незачем — в обоих случаях обновление до них не доехало.
  CREATE TABLE IF NOT EXISTS user_app_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    version TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, platform),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Выполнение задачи — по вхождению, а не по событию: у повторяющейся задачи
  -- «сдать отчёт каждый понедельник» галочка закрывает один понедельник.
  CREATE TABLE IF NOT EXISTS calendar_task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    occurrence_start INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    UNIQUE(event_id, occurrence_start),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
  );

  -- Напоминания о событии: за сколько минут предупредить. Отдельной таблицей,
  -- а не колонкой, чтобы напоминаний могло быть несколько («за день» и «за
  -- 10 минут» — обычная пара) без переделки хранения.
  CREATE TABLE IF NOT EXISTS calendar_event_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    minutes_before INTEGER NOT NULL,
    UNIQUE(event_id, minutes_before),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
  );

  -- Что уже отправили. Без этой таблицы перезапуск сервера или второй тик
  -- слали бы одно напоминание повторно: планировщик не помнит ничего между
  -- тиками намеренно, всё состояние — здесь.
  CREATE TABLE IF NOT EXISTS calendar_reminders_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    occurrence_start INTEGER NOT NULL,
    minutes_before INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    UNIQUE(event_id, occurrence_start, minutes_before),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
  );

  -- Исключение в серии: одно вхождение перенесли или отменили, остальные
  -- остались как были. Ключ — occurrence_start исходной серии, то есть то
  -- место, где вхождение стояло по правилу, а не куда его перенесли.
  CREATE TABLE IF NOT EXISTS calendar_event_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    occurrence_start INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    description TEXT,
    location TEXT,
    starts_at INTEGER,
    ends_at INTEGER,
    all_day INTEGER,
    color TEXT,
    UNIQUE(event_id, occurrence_start),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_reminders_event ON calendar_event_reminders(event_id);
  CREATE INDEX IF NOT EXISTS idx_calendar_exceptions_event ON calendar_event_exceptions(event_id);
  CREATE INDEX IF NOT EXISTS idx_calendar_owner_range ON calendar_events(owner_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_calendar_scope ON calendar_events(scope_kind, scope_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_calendar_guests_user ON calendar_event_guests(user_id);

  -- Групповые чаты. Названы chat_groups, а не groups: имя groups занято
  -- ролевыми группами ("Администрация", "Кафедры") — это разные сущности
  -- (см. комментарий у departments), совпадение имени лишь запутало бы.
  -- Переписка группы хранится в messages как обычно, chat_id вида
  -- 'group_<id>' — видимость решает participantsForChatId по составу
  -- chat_group_members, отдельная система рассылки не нужна.
  CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Права на старте минимальны: 'owner' может переименовать, добавлять и
  -- убирать участников, удалять чужие сообщения и удалить группу целиком;
  -- 'member' может только писать и выйти сам. Более тонкие роли — когда
  -- появится конкретный сценарий, которому текущих двух не хватит.
  CREATE TABLE IF NOT EXISTS chat_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    UNIQUE(chat_group_id, user_id),
    FOREIGN KEY (chat_group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON chat_group_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_group_members_group ON chat_group_members(chat_group_id);

  -- Кто из скольки получателей реально прочитал сообщение в общем/групповом
  -- чате. У messages.status один статус на всё сообщение — для личной
  -- переписки этого достаточно (получатель ровно один), но в чате с
  -- несколькими получателями общий 'read' не может означать "прочитано
  -- мной": как только его выставит первый прочитавший, счётчик непрочитанного
  -- молча пропадает у всех остальных, даже если они сообщение не открывали.
  CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reads_user ON message_reads(user_id);

  -- «Удалить только у себя». Отдельно от messages.deleted: тот значит «убрано
  -- у всех», а здесь — персональное скрытие, когда человек убирает сообщение
  -- из своей переписки, не трогая её у собеседника. Содержимое, как и при
  -- обычном удалении, остаётся в messages нетронутым (юридическое требование
  -- хранить переписку целиком) — прячется только выдача конкретному человеку.
  CREATE TABLE IF NOT EXISTS message_hidden (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_hidden_user ON message_hidden(user_id);

  -- Персональное скрытие корневого сообщения должно скрывать и всю его ветку,
  -- включая ответы, которые появятся позже. Список отдельных message_id этого
  -- обеспечить не может, поэтому корень фиксируется отдельно.
  CREATE TABLE IF NOT EXISTS thread_hidden (
    root_message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (root_message_id, user_id),
    FOREIGN KEY (root_message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Настройки уведомлений хранятся на сервере, чтобы глушение конкретного
  -- пользователя/группы одинаково работало на всех устройствах и для FCM.
  CREATE TABLE IF NOT EXISTS chat_notification_settings (
    user_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_thread_hidden_user ON thread_hidden(user_id);

  -- Реакции на сообщения. PRIMARY KEY (message_id, user_id) — это и есть
  -- правило «одна реакция на человека»: повторная установка идёт через
  -- ON CONFLICT DO UPDATE и заменяет прежнюю, а не добавляет вторую.
  -- Эмодзи храним строкой, как и в emoji_items: набор задаётся в панели и
  -- может меняться, ссылаться на строку справочника незачем.
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);

  -- Задачи-поручения. Отдельно от календарных «задач» (is_task на событии,
  -- привязаны к дате): здесь может быть несколько причастных, а не только
  -- владелец события, и видимость строго по составу task_participants —
  -- задача не должна попадаться в списке тому, кого в неё не звали.
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    created_by INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    due_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Причастные к задаче. Создатель не дублируется сюда автоматически —
  -- видимость и права проверяются как created_by=? OR EXISTS(...participants).
  CREATE TABLE IF NOT EXISTS task_participants (
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (task_id, user_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_task_participants_user ON task_participants(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);

  -- Паки смайликов. Сами смайлики — обычный текст (юникод), а не картинки:
  -- они уже отправляются в сообщениях как есть, и хранить набор строк дешевле
  -- и надёжнее, чем раздавать спрайты. Пак = вкладка в панели выбора.
  CREATE TABLE IF NOT EXISTS emoji_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emoji_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (pack_id) REFERENCES emoji_packs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_emoji_items_pack ON emoji_items(pack_id);
`);

// Миграция: кастомные смайлики картинками. Пак теперь бывает двух видов —
// юникодный (как раньше, `emoji` заполнен) и картиночный (`file_path` + `name`).
// Разделение по items, а не по паку: колонка `kind` на паке потребовала бы
// запрещать смешивание, а запрещать нечего — вид элемента виден по нему самому.
//
// `name` — короткое имя вида :cat:, ИМЕННО ОНО уезжает в текст сообщения.
// Картинку в `messages.text` не положить, а менять формат хранения сообщений
// ради смайликов нельзя: там лежит трёхлетний архив, который трогать запрещено.
try {
  db.exec(`ALTER TABLE emoji_items ADD COLUMN name TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE emoji_items ADD COLUMN file_path TEXT`);
} catch (e) {
  // Колонка уже есть
}
// Имя уникально глобально, а не внутри пака: в тексте сообщения пака нет —
// там только :name:, и по нему нужно однозначно найти картинку.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_items_name ON emoji_items(name) WHERE name IS NOT NULL`);

// Миграция: `retired` — след прежнего порядка, когда смайлик не удалялся, а
// прятался, и имя оставалось занятым навсегда. 12.08.2026 пользователь решил
// иначе: удалили — значит не нужен, строка и файл стираются, имя освобождается
// (см. DELETE /api/emoji/admin/custom/:itemId). Колонка осталась ради уже
// спрятанных строк: их видно в панели, откуда их можно вернуть или снести
// насовсем. Новые смайлики сюда больше не попадают.
try {
  db.exec(`ALTER TABLE emoji_items ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Колонка уже есть
}
// Базовый юникодный эмодзи картиночного смайлика — для мест, где картинку
// показать нечем: уведомления ОС, буфер обмена, alt пропавшего файла.
try {
  db.exec(`ALTER TABLE emoji_items ADD COLUMN fallback_emoji TEXT`);
} catch (e) {
  // Колонка уже есть
}
// Анимированная версия смайлика — ОТДЕЛЬНЫМ файлом, а не заменой статичной.
// Нужны обе сразу: в панели выбора десятки смайликов на экране, и если каждый
// будет дёргаться, выбрать из них ничего нельзя — там всегда показывается
// статичная. Анимация появляется только в переписке, и только если человек не
// выключил её у себя (личная настройка, не общая).
try {
  db.exec(`ALTER TABLE emoji_items ADD COLUMN animated_path TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Новая модель каталога: emoji_items — логический Unicode-смайлик, а файлы
// Apple / Telegram / Google Fonts являются его взаимозаменяемыми вариантами.
// Старые file_path/animated_path пока остаются как совместимый «срез» активных
// наборов: это позволяет обновлять сервер отдельно от уже установленных клиентов.
for (const sql of [
  `ALTER TABLE emoji_items ADD COLUMN unicode_key TEXT`,
  `ALTER TABLE emoji_items ADD COLUMN label TEXT`,
  `ALTER TABLE emoji_items ADD COLUMN keywords TEXT`,
  `ALTER TABLE emoji_packs ADD COLUMN structure_key TEXT`,
]) {
  try { db.exec(sql); } catch (e) { /* колонка уже есть */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS emoji_asset_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('base', 'animation')),
    enabled INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emoji_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    asset_pack_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (item_id, asset_pack_id),
    FOREIGN KEY (item_id) REFERENCES emoji_items(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_pack_id) REFERENCES emoji_asset_packs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_emoji_assets_item ON emoji_assets(item_id);
  CREATE INDEX IF NOT EXISTS idx_emoji_assets_pack ON emoji_assets(asset_pack_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_items_unicode_key
    ON emoji_items(unicode_key) WHERE unicode_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS emoji_structure (
    unicode_key TEXT PRIMARY KEY,
    emoji TEXT NOT NULL,
    group_name TEXT NOT NULL,
    subgroup_name TEXT,
    position INTEGER NOT NULL,
    label TEXT,
    keywords TEXT
  );
`);

const nowForEmojiAssets = Date.now();
db.prepare(`
  INSERT OR IGNORE INTO emoji_asset_packs (key, name, role, enabled, active, position, created_at)
  VALUES ('apple', 'Apple', 'base', 1, 1, 0, ?)
`).run(nowForEmojiAssets);
db.prepare(`
  INSERT OR IGNORE INTO emoji_asset_packs (key, name, role, enabled, active, position, created_at)
  VALUES ('animation', 'Telegram Animation', 'animation', 1, 1, 1, ?)
`).run(nowForEmojiAssets);

// Уже загруженные u_... связываем с Unicode без повторной загрузки. Обычные
// пользовательские :name: остаются как были и не участвуют в смене оформления.
const keyFromLegacyEmojiName = (name) => {
  const match = /^u_([0-9a-f_]+)$/i.exec(String(name || ''));
  if (!match) return null;
  const parts = match[1].toLowerCase().split('_').filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[0-9a-f]{2,6}$/.test(part))) return null;
  return parts.join('-');
};
const appleAssetPackId = db.prepare("SELECT id FROM emoji_asset_packs WHERE key = 'apple'").get().id;
const animationAssetPackId = db.prepare("SELECT id FROM emoji_asset_packs WHERE key = 'animation'").get().id;
const setLegacyUnicodeKey = db.prepare('UPDATE emoji_items SET unicode_key = ? WHERE id = ? AND unicode_key IS NULL');
const addLegacyAsset = db.prepare(`
  INSERT OR IGNORE INTO emoji_assets (item_id, asset_pack_id, file_path, created_at)
  VALUES (?, ?, ?, ?)
`);
for (const item of db.prepare(`
  SELECT id, name, file_path, animated_path FROM emoji_items
  WHERE name IS NOT NULL AND (file_path IS NOT NULL OR animated_path IS NOT NULL)
`).all()) {
  const key = keyFromLegacyEmojiName(item.name);
  if (key) setLegacyUnicodeKey.run(key, item.id);
  if (item.file_path) addLegacyAsset.run(item.id, appleAssetPackId, item.file_path, nowForEmojiAssets);
  if (item.animated_path) addLegacyAsset.run(item.id, animationAssetPackId, item.animated_path, nowForEmojiAssets);
}

// Миграция: добавляем колонку status, если БД старая
try {
  db.exec(`ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: редактирование/удаление сообщений
try {
  db.exec(`ALTER TABLE messages ADD COLUMN edited_at DATETIME`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: размеры картинки в сообщении. file_path существовал с самого
// начала, но им никто не пользовался; ширина/высота — чтобы клиент мог
// отрисовать плейсхолдер под нужный размер до того, как файл загрузится, и
// не дёргать вёрстку, когда изображение наконец появится.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN file_width INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN file_height INTEGER`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: IP отправителя. Метаданные о факте передачи сообщения (время,
// отправитель, получатель, IP) обязаны храниться отдельно от содержимого —
// удаление сообщения (см. message_delete) стирает text/file_path, но не эту
// колонку и не саму строку целиком: удалённое сообщение остаётся в базе,
// просто без содержимого и невидимым в интерфейсе.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sender_ip TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: ответ на сообщение. Без внешнего ключа намеренно — на исходное
// сообщение можно ответить, а потом его удалят (deleted=1, строка остаётся),
// и цитата должна пережить это, показав «сообщение удалено» вместо текста.
// Пересылка отмечается парой forwarded_from_*: имя автора берём снимком, а не
// join'ом по id, потому что человека могут переименовать или удалить, а в
// пересланном сообщении должно остаться то, что видел пересылавший.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: когда сообщение прочитали — для пункта «Прочитано в [время]» в
// меню сообщения. Только для личной переписки: там получатель ровно один и
// метка однозначна. В общих чатах и группах «кто и когда прочитал» живёт в
// message_reads по человеку, и одной метки на сообщение там не бывает.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN read_at INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN forwarded_from_name TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN forwarded_from_chat TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Идентификатор назначает клиент до первой попытки отправки и хранит вместе
// с сообщением в локальной очереди. Если сервер успел записать сообщение, но
// подтверждение потерялось при обрыве сети, повтор с тем же id должен вернуть
// уже существующую строку, а не создать дубликат.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN client_message_id TEXT`);
} catch (e) {
  // Колонка уже есть
}
// Ответ ветки остаётся обычным сообщением со всеми юридически значимыми
// полями, но не попадает в основную ленту. Корнем всегда является сообщение
// верхнего уровня; вложенных веток нет.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN thread_root_id INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN deleted_at INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN deleted_by INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN force_notification INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE device_tokens ADD COLUMN capabilities TEXT NOT NULL DEFAULT ''`);
} catch (e) {
  // Колонка уже есть
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client_id
  ON messages(sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL
`);

// Миграция: группы, роли, режим тишины — управляются из панели супер-админа
try {
  db.exec(`ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES groups(id)`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN muted INTEGER DEFAULT 0`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: логин/пароль больше не единственное поле профиля — появляется
// отдельное отображаемое имя и стандартные для мессенджера поля.
try {
  db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN avatar_path TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Бэкфилл: до появления display_name отображаемым именем был сам логин —
// чтобы после обновления ни у кого не осталось пустое имя, копируем логин
// туда, где отображаемое имя ещё не задано.
db.prepare(`UPDATE users SET display_name = username WHERE display_name IS NULL OR TRIM(display_name) = ''`).run();

// Миграция: Тип учётной записи (Сотрудник/Интернет/Мирас) — раньше это был
// вычисляемый на лету признак (префикс miras_ в логине), теперь реальное
// редактируемое поле. account_type по умолчанию 'staff' — этого достаточно
// для всех строк, кроме зеркал МИРАС, их бэкфилим отдельно.
try {
  db.exec(`ALTER TABLE users ADD COLUMN account_type TEXT DEFAULT 'staff'`);
} catch (e) {
  // Колонка уже есть
}
db.prepare(`UPDATE users SET account_type = 'miras' WHERE username LIKE 'miras\\_%' ESCAPE '\\'`).run();

// Миграция: сброс пароля супер-админом ("Сменить") — храним момент сброса в
// unix-миллисекундах, а не SQL DATETIME. У SQLite CURRENT_TIMESTAMP нет
// таймзоны в строке, и разбор такой строки в JS на клиенте/сервере — источник
// той же путаницы, что и с временем сообщений; unix-время такой проблемы не имеет.
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_reset_requested_at INTEGER`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: расширенные поля профиля — отдел, должность, дата рождения
// (дата — строка 'YYYY-MM-DD', как отдаёт <input type="date">).
try {
  db.exec(`ALTER TABLE users ADD COLUMN department TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN position TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN birth_date TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Сиды: стартовые группы + единственный супер-админ панели управления.
// Пароль генерируется один раз при первом запуске (если не задан через env)
// и больше нигде не хранится в открытом виде — только его bcrypt-хэш в БД.
function ensureGroup(name) {
  const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO groups (name) VALUES (?)').run(name).lastInsertRowid;
}

ensureGroup('Администрация');
ensureGroup('Кафедры');

// Отдел ссылкой, а не строкой: раньше это было свободное текстовое поле, и
// переименование отдела в панели осиротило бы всех, кто в нём числится.
try {
  db.exec(`ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id)`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: статус профиля (в отпуске / на обеде / болею / выходной / свой
// текст). Пресет и свой текст взаимоисключающие — хранятся в двух колонках,
// а не одной, чтобы не городить в одной строке признак "это пресет или
// текст" сравнением со списком ключей.
try {
  db.exec(`ALTER TABLE users ADD COLUMN status_preset TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN status_custom TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: срок действия статуса. NULL — бессрочно, как было раньше.
// Снимается лениво, при чтении статусов (см. clearExpiredStatuses в
// services/statusExpiry.js), а не по таймеру: планировщик пришлось бы держать
// живым между перезапусками pm2, а выгода нулевая — статус всё равно никто не
// видит, пока не запросит список людей.
try {
  db.exec(`ALTER TABLE users ADD COLUMN status_expires_at INTEGER`);
} catch (e) {
  // Колонка уже есть
}

// Свои обои под лентой сообщений. Настройка личная и общая на все чаты сразу:
// отдельный фон у каждой переписки — другая задача, и заводить под неё таблицу
// заранее незачем. Хранится на сервере, а не в localStorage, как остальные
// настройки вида: человек ставит картинку один раз и ждёт её на всех своих
// устройствах, а не заново на каждом.
try {
  db.exec('ALTER TABLE users ADD COLUMN chat_background_path TEXT');
} catch (e) {
  // Колонка уже есть
}

function ensureDepartment(name) {
  const existing = db.prepare('SELECT id FROM departments WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO departments (name) VALUES (?)').run(name).lastInsertRowid;
}

['Автоматизация', 'Зам.дир', 'Ресепшен'].forEach(ensureDepartment);

// Бэкфилл: до появления справочника отдел писали строкой. Заводим отдел под
// каждое встреченное значение и переводим людей на ссылку — иначе после
// перехода на выпадающий список у них молча опустело бы поле.
try {
  const written = db.prepare(`
    SELECT DISTINCT TRIM(department) AS name FROM users
    WHERE department IS NOT NULL AND TRIM(department) != '' AND department_id IS NULL
  `).all();

  const link = db.prepare('UPDATE users SET department_id = ? WHERE TRIM(department) = ? AND department_id IS NULL');
  for (const row of written) link.run(ensureDepartment(row.name), row.name);
} catch (e) {
  console.error('Ошибка бэкфилла отделов:', e);
}

// Стартовый пак смайликов. Заводится один раз: дальше состав правят из панели
// управления, и повторный сид затирал бы эти правки при каждом перезапуске.
const emojiPackCount = db.prepare('SELECT COUNT(*) AS c FROM emoji_packs').get().c;
if (emojiPackCount === 0) {
  const BASE_EMOJI = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊',
    '😍', '😘', '😋', '😎', '🤓', '🧐', '🤔', '🤗', '🙃', '😐',
    '😴', '😪', '😥', '😰', '😭', '😡', '🤯', '😱', '🥳', '🤝',
    '👍', '👎', '👌', '✌️', '🙏', '👏', '💪', '🖐️', '☝️', '✍️',
    '❤️', '🔥', '⭐', '✅', '❌', '❗', '❓', '💡', '📌', '📎',
    '🎉', '🎂', '☕', '🍰', '🌸', '☀️', '🌧️', '❄️', '🚀', '💼',
  ];
  const packId = db.prepare(
    'INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES (?, 0, 1, ?)'
  ).run('Основные', Date.now()).lastInsertRowid;
  const insertEmoji = db.prepare('INSERT INTO emoji_items (pack_id, emoji, position) VALUES (?, ?, ?)');
  BASE_EMOJI.forEach((emoji, index) => insertEmoji.run(packId, emoji, index));
}

// Миграция: архивирование задач. Исполнитель может убрать выполненную задачу
// из основных списков, не удаляя её, — история поручений остаётся доступной
// отдельной вкладкой. Ставится только на завершённых (проверяется на сервере,
// не колонкой), поэтому отдельного времени архивации не хранится.
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: канал-объявление. ИСТОРИЧЕСКИ этот флаг означал сразу две вещи —
// «писать могут только админы» и «показывать счётчик просмотров». Право писать
// с него снято и живёт в write_policy (ниже), флаг остался только за
// счётчиком просмотров.
try {
  db.exec(`ALTER TABLE chat_groups ADD COLUMN announcements_only INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Колонка уже есть
}

// Миграция: «Кто может писать» — единый механизм прав отправки для групп.
// Значения write_policy:
//   all         — любой участник группы;
//   members     — только перечисленные поимённо (chat_group_writers);
//   departments — только сотрудники указанных отделов (chat_group_writer_departments);
//   admins      — только орг-администрация (users.role admin/moderator);
//   nobody      — никто, чат заморожен на чтение.
// Неявных исключений нет НИ ДЛЯ КОГО, включая владельца группы: в требованиях
// «только администратор» — отдельный вариант, значит в остальных режимах
// администратор не должен получать право молча. Владелец, которому нужно
// писать, добавляет себя в список — это видно и предсказуемо.
try {
  db.exec(`ALTER TABLE chat_groups ADD COLUMN write_policy TEXT NOT NULL DEFAULT 'all'`);
  // Перенос старого смысла флага: каналы-объявления продолжают работать
  // ровно как раньше. Внутри try — выполняется единожды, при добавлении
  // колонки, иначе затирало бы политику, выставленную вручную позже.
  db.exec(`UPDATE chat_groups SET write_policy = 'admins' WHERE announcements_only = 1`);
} catch (e) {
  // Колонка уже есть
}

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_group_writers (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_group_writer_departments (
    group_id INTEGER NOT NULL,
    department_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, department_id),
    FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
  );
`);

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

// Стикеры — самостоятельный тип сообщения, а не подстановка внутри текста
// (как кастомные смайлики): их не печатают кодом, значит не нужны ни
// глобально уникальное имя, ни разбор шорткодов. Структура паков/элементов
// та же, что у emoji_packs/emoji_items, просто без этой части.
db.exec(`
  CREATE TABLE IF NOT EXISTS sticker_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cover_path TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sticker_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    emoji TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    retired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id);
`);

// sticker_id — ссылка на элемент пака (резолвится через живой каталог, как
// :code: у смайликов), простой INTEGER без FK-объявления — так же, как
// reply_to_id/thread_root_id: внешние ключи в этой базе нигде не проверяются
// движком (PRAGMA foreign_keys не включена), а удаление стикера в админке НЕ
// обязано трогать строку сообщения. sticker_fallback — копия emoji элемента
// НА МОМЕНТ ОТПРАВКИ: в отличие от смайлика, стикер не может деградировать
// до текста при удалении картинки, поэтому нужен готовый глиф про запас.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sticker_id INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sticker_fallback TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Файлы (документы, архивы) — ОТДЕЛЬНЫЕ колонки от картинок, а не общий
// «attachment». Картинка и файл ведут себя по-разному во всём: картинка
// пережимается в webp и показывается прямо в ленте, файл сохраняется как есть
// и показывается карточкой со скачиванием. Свести их в одну пару колонок
// значило бы на каждом шаге спрашивать «а это картинка или нет» — ровно тот
// разбор, которого удалось избежать у поллов и стикеров.
//
// document_name хранится отдельно от пути: на диске имя обеззараживается и
// дополняется случайной частью, а человеку надо показать то, что он отправил.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN document_path TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN document_name TEXT`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN document_size INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN document_mime TEXT`);
} catch (e) {
  // Колонка уже есть
}

// Убранное вложение: файл уезжает в zip в личной папке отправителя, а само
// сообщение остаётся на месте. Хранить обязаны и то и другое — содержимое
// переписки по закону не удаляется, но из приложения вложение должно пропасть.
// Поэтому не «удалено», а «архивировано»: путь к архиву тут же, рядом.
// Фото профиля группы — правит владелец. Хранится как путь, ровно как
// аватар человека; сам файл лежит в личной папке того, кто его загрузил.
try {
  db.exec(`ALTER TABLE chat_groups ADD COLUMN avatar_path TEXT`);
} catch (e) {
  // Колонка уже есть
}

try {
  db.exec(`ALTER TABLE messages ADD COLUMN attachment_archived_at INTEGER`);
} catch (e) {
  // Колонка уже есть
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN attachment_archive_path TEXT`);
} catch (e) {
  // Колонка уже есть
}

const superAdminCount = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
if (superAdminCount === 0) {
  const initialUsername = process.env.SUPERADMIN_USERNAME || 'superadmin';
  const initialPassword = process.env.SUPERADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO super_admins (username, password) VALUES (?, ?)')
    .run(initialUsername, bcrypt.hashSync(initialPassword, 10));
  console.log('=== Создан супер-админ панели управления ===');
  console.log('Логин:   ', initialUsername);
  console.log('Пароль:  ', initialPassword, '(сохраните — больше нигде не показывается)');
  console.log('=============================================');
}

// Индексы
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
  CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_recent_user_opened
    ON chat_recent_openings(user_id, last_opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_comments_user_id ON user_comments(user_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_notification_settings_user
    ON chat_notification_settings(user_id, muted);
`);

// До появления отдельной истории открытий точного времени не было. Для уже
// существующих аккаунтов берём время последнего исходящего сообщения как
// безопасное начальное приближение, чтобы после обновления блок «Недавние» не
// оказался пустым. INSERT OR IGNORE не перезаписывает реальные открытия.
db.exec(`
  INSERT OR IGNORE INTO chat_recent_openings (user_id, chat_id, last_opened_at)
  SELECT sender_id, chat_id,
         CAST(strftime('%s', MAX(created_at)) AS INTEGER) * 1000
  FROM messages
  WHERE chat_id != 'general'
  GROUP BY sender_id, chat_id;
`);

// Бэкфилл контактов: до появления подписок чат-лист был "все зарегистрированные",
// так что существующие переписки бэкфилим в contacts в обе стороны — иначе
// после обновления у всех опустеют списки чатов. INSERT OR IGNORE — безопасно
// гонять при каждом запуске, повторные проходы просто ничего не делают.
try {
  const existingChatIds = db.prepare('SELECT DISTINCT chat_id FROM messages').all().map(row => row.chat_id);
  const insertContact = db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)');

  const backfillContacts = db.transaction(() => {
    for (const chatId of existingChatIds) {
      const match = String(chatId).match(/^chat_(\d+)_(\d+)$/);
      if (!match) continue;
      const [a, b] = [Number(match[1]), Number(match[2])];
      insertContact.run(a, b);
      insertContact.run(b, a);
    }
  });

  backfillContacts();
} catch (e) {
  console.error('Ошибка бэкфилла контактов:', e);
}

// Индексы под самые горячие выборки: история чата (chat_id + порядок),
// подсчёт непрочитанного и отметка доставленных при входе в сеть — все они
// раньше упирались в полный скан таблицы сообщений, который с ростом
// переписки заметно тормозил и открытие чата, и подключение сокета.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, sender_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
`);

// Переезд загрузок в личные папки пользователей. Идемпотентно и потому идёт на
// каждом запуске: уже перенесённое пропускается за один запрос, а «выполнить
// один раз руками» — это то, о чём забывают при следующей выкладке.
try {
  require('./services/userStorage').migrateLegacyUploads(db);
} catch (e) {
  // Не повод не подняться: старые пути остаются рабочими, файлы читаются
  // оттуда же, где лежали.
  console.error('Не удалось разложить загрузки по личным папкам:', e.message);
}

module.exports = db;
