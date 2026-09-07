// Основные таблицы: люди, переписка, календарь, задачи, группы.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
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
};
