/**
 * Задачи как таск-трекер: исполнитель, источник, журнал удалений.
 *
 * Отдельным шагом, а не дописыванием в 04: там миграции 2026 года, и мешать
 * их с редизайном значит потерять и то и другое при следующем разборе.
 *
 * Все ALTER идемпотентны — шаг выполняется на КАЖДОМ старте сервера, как и
 * остальные.
 */
module.exports = function migrateTasks(db) {
  const addColumn = (sql) => {
    try {
      db.exec(sql);
    } catch (e) {
      // Колонка уже есть — шаг обязан переживать повторный запуск.
    }
  };

  // Исполнитель. ОДНО поле, а не таблица: решение пользователя от 07.09.2026 —
  // «задача может перемещаться от исполнителя к исполнителю», то есть
  // ответственный в каждый момент один, а передача это обычная правка задачи.
  // NULL — задача ещё никому не поручена; такие видны всем причастным, иначе
  // взять их было бы некому.
  addColumn('ALTER TABLE tasks ADD COLUMN assignee_id INTEGER REFERENCES users(id)');

  // Откуда задача взялась. Два значения настоящие — 'manual' и 'chat';
  // 'order' (заказ книг) заложен заранее, но НЕ используется: внешней базы
  // пока нет даже в договорённостях, и показывать источник, которого не
  // существует, значит соврать на карточке.
  addColumn("ALTER TABLE tasks ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'");
  // Ссылка внутри источника: chat_id для задачи из чата, номер для заказа.
  // Свободный текст намеренно — у разных источников разные ключи, и заводить
  // под каждый свою колонку значит переделывать схему на каждом новом.
  addColumn('ALTER TABLE tasks ADD COLUMN source_ref TEXT');
  // Человекочитаемое имя источника на момент создания («Методисты»). Копией, а
  // не join'ом: чат могут переименовать или удалить, а карточка обязана
  // помнить, откуда задача пришла.
  addColumn('ALTER TABLE tasks ADD COLUMN source_label TEXT');

  // Мягкое удаление. Раньше задача стиралась физически (DELETE FROM tasks) —
  // без следа, без причины и без возврата, при том что удалить может любой
  // причастный. Теперь строка остаётся, а журнал отвечает на «кто, когда и
  // почему».
  addColumn('ALTER TABLE tasks ADD COLUMN deleted_at INTEGER');
  addColumn('ALTER TABLE tasks ADD COLUMN deleted_by INTEGER REFERENCES users(id)');
  addColumn('ALTER TABLE tasks ADD COLUMN delete_reason TEXT');
  // Статус НА МОМЕНТ удаления. Держим отдельно, потому что восстановление
  // возвращает задачу в работу и статус может смениться дальше, а журнал
  // обязан показывать то, что было в минуту удаления.
  addColumn('ALTER TABLE tasks ADD COLUMN deleted_status TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);
  `);

  // Разовый перенос: у задачи с единственным причастным он и есть исполнитель.
  // Проверено на боевой базе — там 4 задачи, у каждой ровно один причастный,
  // так что перенос однозначен. Там, где причастных несколько или нет вовсе,
  // исполнитель остаётся не назначенным: угадывать, с кого спрос, нельзя.
  db.exec(`
    UPDATE tasks
       SET assignee_id = (
             SELECT p.user_id FROM task_participants p WHERE p.task_id = tasks.id
           )
     WHERE assignee_id IS NULL
       AND (SELECT COUNT(*) FROM task_participants p WHERE p.task_id = tasks.id) = 1
  `);
};
