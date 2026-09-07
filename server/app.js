const express = require('express');
const cors = require('cors');

const verifyToken = require('./middleware/verifyToken');
const requireAdminRole = require('./middleware/requireAdminRole');

const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');
const unreadRoutes = require('./routes/unread');
const favoritesRoutes = require('./routes/favorites');
const commentsRoutes = require('./routes/comments');
const superadminRoutes = require('./routes/superadmin');
const contactsRoutes = require('./routes/contacts');
const moderationRoutes = require('./routes/moderation');
const devicesRoutes = require('./routes/devices');
const updatesRoutes = require('./routes/updates');
const calendarRoutes = require('./routes/calendar');
const googleCalendarRoutes = require('./routes/googleCalendar');
const sessionRoutes = require('./routes/session');
const departmentsRoutes = require('./routes/departments');
const groupsRoutes = require('./routes/groups');
const tasksRoutes = require('./routes/tasks');
const emojiRoutes = require('./routes/emoji');
const stickerRoutes = require('./routes/stickers');
const filesRoutes = require('./routes/files');
const notificationSettingsRoutes = require('./routes/notificationSettings');

// Сборка HTTP-части. Отделена от точки входа, потому что смешивать «какие
// маршруты есть у приложения» и «как оно поднимается» — значит каждый раз
// пролистывать одно ради другого.
const app = express();
app.use(cors());
app.use(express.json());

// REST API
app.use('/api/auth', authRoutes);
app.use('/api/messages', verifyToken, messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/unread', unreadRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/moderation', verifyToken, requireAdminRole, moderationRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/updates', updatesRoutes);
// Раньше общего календаря: у гугловых ручек своя проверка прав (супер-админ),
// а у адреса возврата её нет и быть не может — см. комментарий в маршруте.
app.use('/api/calendar/google', googleCalendarRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/departments', departmentsRoutes);
app.use('/api/groups', verifyToken, groupsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/emoji', emojiRoutes);
app.use('/api/stickers', stickerRoutes);
// Личное хранилище: раздел «Файлы» на рельсе.
app.use('/api/files', filesRoutes);
app.use('/api/notification-settings', notificationSettingsRoutes);

// Раздача загруженных аватаров — просто статика, без отдельной авторизации
// на каждый файл (как публичные CDN-ссылки на фото профиля у большинства
// мессенджеров), доступ к самому приложению уже закрыт логином/паролем.
// Смонтировано под /api/uploads (а не просто /uploads): в проде reverse-proxy
// проксирует на бэкенд только префикс /api — отдельного правила для /uploads
// нет, и файлы отдавались бы SPA-фолбэком (index.html) вместо самой картинки.
// Кэш навсегда: по умолчанию express.static шлёт `max-age=0`, и браузер
// перепроверяет КАЖДЫЙ файл при каждом открытии — пусть ответом и будет 304,
// но на слабой связи это лишний круговой обход на каждый смайлик, аватар и
// картинку. Именно это делало открытие группы заметно медленнее личного чата:
// в группе под каждым сообщением аватар, и таких перепроверок десятки.
//
// immutable здесь не допущение, а свойство схемы имён: содержимое по одному и
// тому же пути не меняется НИКОГДА. Аватар — `user_<id>_<время>.jpg` (новая
// загрузка = новое имя, старый файл удаляется), картинка сообщения —
// `msg_<id>_<время>_<случайное>.webp`, смайлик — `emoji_<имя>_<случайное>.webp`
// (замена картинки под тем же кодом пишет НОВЫЙ файл и удаляет прежний).
// Заводя загрузку с предсказуемым именем, это правило придётся пересмотреть.
app.use('/api/uploads', express.static(require('./services/userStorage').UPLOADS_DIR, {
  maxAge: '365d',
  immutable: true,
}));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

module.exports = app;
