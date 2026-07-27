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