const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Стартовые данные, индексы и разовые досчёты.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
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
};
