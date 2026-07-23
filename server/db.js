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
`);

module.exports = db;