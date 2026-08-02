const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, 'messenger.db'));

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

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, chat_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
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

// Миграция: канал-объявление. Группа, где писать могут только люди с ролью
// admin/moderator в организации (users.role), а не по составу самой группы —
// это про орг-роль, а не про то, кто её создал. Обычные участники состоят в
// группе и читают, но при попытке отправить получают message_blocked, как в
// режиме тишины.
try {
  db.exec(`ALTER TABLE chat_groups ADD COLUMN announcements_only INTEGER NOT NULL DEFAULT 0`);
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
  CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_comments_user_id ON user_comments(user_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
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

module.exports = db;