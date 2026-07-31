## Compact Instructions

При сжатии обязательно сохрани:

**Архитектурные решения**
- Групповые чаты: таблицы `chat_groups` + `chat_group_members` (роль `owner`/`member`, минимум прав). `chat_id` вида `group_<id>`. Переиспользуют существующий пайплайн сообщений/сокетов (`chatParticipants.js` научили распознавать `group_\d+`) — отдельной системы рассылки нет.
- Чтение в общих/групповых чатах: `messages.status` — общая колонка на всё сообщение, не годится для «прочитано мной» при нескольких получателях. Добавлена таблица `message_reads` (per-user) + `services/readReceipts.js` с `isSharedChat()`/`markRead()`. Личные чаты (1:1) по-прежнему считаются по `status`.
- Мобильный фокус/жизненный цикл: на Android нельзя полагаться на DOM `focus`/`blur`/`visibilitychange` — используется `CapApp.appStateChange` как источник истины.
- Навигация мобильного экрана: настоящая причина «чат-ловушки» — `hideMobileKeyboard()` без `.catch()` намертво ломал выход из чата при отказе нативного моста. Это не то же самое, что более ранний фикс (`setSection('chats')` → `goToSection`) — оба фикса легитимны и оба нужны.
- Задачи (`server/routes/tasks.js`) — поручения, отдельная сущность от календарных «задач» (`is_task` на событии). Видимость строго по составу `task_participants`: создатель + причастные, никто больше. Статус меняет любой причастный, не только автор.
- Аккаунты `account_type = 'internet'` видят урезанный NavRail (`INTERNET_VISIBLE_SECTIONS` в `NavRail.tsx`) и не получают общий календарь — фильтрация на сервере (`canSeeGlobalCalendar` в `routes/calendar.js`), а не только в интерфейсе.
- Картинки в чате: `messages.file_path` существовал в схеме с самого начала, но был не подключён — теперь используется (+ `file_width`/`file_height`). Путь от клиента для `chat_message` не доверенный: `isValidChatImagePath` (`routes/messages.js`) сверяет формат и то, что файл реально существует на диске. Удаление сообщения чистит и колонку, и сам файл (`deleteUploadedFile` в `utils/files.js` — общая для аватаров и картинок чата).

**Контракты данных**
- `CalendarOccurrence`, `EventDraft`, слои календаря (`global`/`personal`/`birthdays`/`space:<id>`).
- Группа: `{id, chat_id, name, created_by, created_at, member_count, role, members[]}` — см. `server/routes/groups.js`.
- Задача: `{id, title, description, status, due_at, created_by, participants[], can_edit}` — см. `server/routes/tasks.js`. `status` — `not_started`/`in_progress`/`done`.
- Статус профиля: `users.status_preset` (пресет из фиксированного набора) + `users.status_custom` (свой текст) — взаимоисключающие, см. `utils/statusMeta.ts`.

**Состояние миграций БД** (порядок применения)
- `chat_groups`, `chat_group_members` → `message_reads` → `tasks`, `task_participants` → `users.status_preset`/`status_custom` → `messages.file_width`/`file_height`. Все идемпотентны, накатаны на проде.

**Текущая версия и деплой**
- Прод сейчас: 1.5.6 на всех платформах (сервер/веб/Windows/Android) — versionCode 23 для Android.
- Расписание обновлений (`notBefore`) на проде настроено пользователем — не трогать без явной просьбы.

**Правила деплоя**
- Команда «Отправить/Отправляй» = полный цикл: коммит+пуш, деплой сервер+веб, бамп версий win+apk, сборка обеих, заливка с проверкой sha512, чистка старых файлов только после проверки хешей.

**Незакрытые вопросы / известные хвосты**
- Старая ошибка в error-логе сервера (SQLITE_CONSTRAINT_FOREIGNKEY, 27 июля) — не новая, безопасно игнорировать при чтении логов.
- Локальный dev-пароль супер-админа сброшен на `devtest123` для тестирования — прод не затронут.
- Не реализовано: drag-and-drop событий календаря, поиск по сообщениям, free/busy при приглашении.

**Не сохраняй**
- Полные листинги прочитанных файлов
- Вывод тестов и линтера
- Промежуточные рассуждения, приведшие к отброшенным вариантам
