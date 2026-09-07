const bcrypt = require('bcryptjs');

// Профиль, тип аккаунта, статусы, группы и права записи, задачи.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
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
};
