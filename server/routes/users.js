const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const sharp = require('sharp');
const { isValidLogin, isReservedLogin, isValidPassword, isValidDisplayName, isValidPhone, isValidBio, isValidShortText, isValidBirthDate } = require('../utils/validators');
const { deleteAvatarFile, deleteUploadedFile } = require('../utils/files');
const { archiveAndDeleteUser } = require('../services/accountArchive');
const { clearExpiredStatuses } = require('../services/statusExpiry');
const { selfChatId } = require('../services/chatParticipants');
const { getSelfChatName, getReactionEmoji } = require('../services/appSettings');
const userStorage = require('../services/userStorage');
const router = express.Router();

const AVATARS_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });

const AVATAR_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const PROFILE_PHOTO_MAX_WIDTH = 1200;
const PROFILE_PHOTO_MAX_HEIGHT = 1600;
const AVATAR_JPEG_QUALITY = 85;

// Буфер в памяти, а не сразу на диск — файл сначала прогоняем через sharp.
// avatar_path теперь используется не только маленьким круглым аватаром, но и
// вертикальным hero-фото профиля. Поэтому больше НЕ режем файл в квадрат:
// сохраняем его пропорции, только ограничиваем размер и качество. Круглый
// Avatar сам берёт центральный квадрат через object-fit: cover.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED_MIME.includes(file.mimetype)),
});

// Обои под лентой сообщений. Предел по ВЫСОТЕ больше, чем по ширине: лента
// всегда выше своей ширины, и сюда несут вертикальные снимки с телефона.
// Качество ниже аватарного: это фон за текстом, разницы не видно, а место
// экономит заметно — при сотне сотрудников счёт идёт на гигабайты.
const BACKGROUNDS_DIR = path.join(__dirname, '..', 'uploads', 'backgrounds');
fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });

const BACKGROUND_MAX_WIDTH = 1080;
const BACKGROUND_MAX_HEIGHT = 1920;
const BACKGROUND_QUALITY = 62;

const backgroundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED_MIME.includes(file.mimetype)),
});

// Исключений из разделения типов аккаунтов в справочнике БОЛЬШЕ НЕТ.
//
// Раньше администрация (орг-роль admin/moderator либо группа «Админы») видела
// обе стороны и была видна обеим — чтобы «Интернету» было у кого попросить
// смену типа аккаунта. По требованию пользователя (15.08.2026) это снято
// целиком: одновременно оба типа видит только супер-админ в панели
// управления, у которой свой отдельный вход и своя выдача пользователей.
// Следствие, о котором нужно помнить: из самого приложения «Интернет»
// написать администрации уже не может — просьбу о смене типа придётся
// передавать мимо мессенджера.

// Получить всех пользователей (кроме текущего) — справочник для поиска.
// miras_* — служебные зеркала админов МИРАС для маршрутизации сообщений,
// в списке реальных сотрудников их быть не должно.
//
// Два типа аккаунтов в справочнике не видят друг друга ВОВСЕ, без исключений.
// "Интернет" (незнакомые с улицы, самостоятельная регистрация) видит только
// других "Интернет", а "Сотрудник" — только сотрудников: это посторонние люди,
// и в списке коллег им не место. После того как супер-админ переведёт человека
// в "Сотрудник", тот попадает в общий справочник и видит его целиком.
router.get('/', verifyToken, (req, res) => {
  try {
    clearExpiredStatuses();
    const requester = db.prepare(`
      SELECT u.account_type, u.role, g.name AS group_name
      FROM users u LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id = ?
    `).get(req.userId);
    const restrictToInternet = !!requester && requester.account_type === 'internet';
    // Никаких «кроме администрации»: не «Интернет» — значит «Интернет» не видит.
    const hideInternet = !restrictToInternet;

    // bio/phone/position/birth_date добавлены ради профиля (UserInfoModal):
    // раньше справочник отдавал только то, что нужно для строки в списке, и
    // окно профиля, открытое не для контакта (а для любого сотрудника из
    // «Люди»), оставалось наполовину пустым по сравнению с тем же профилем,
    // открытым из уже добавленного контакта (там эти поля берутся из /contacts).
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.phone, u.position, u.birth_date,
             u.group_id, g.name AS group_name, u.department_id, d.name AS department,
             u.status_preset, u.status_custom, u.created_at
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id != ?
        AND u.username NOT LIKE 'miras\_%' ESCAPE '\\'
        AND (? = 0 OR u.account_type = 'internet')
        AND (? = 0 OR COALESCE(u.account_type, 'staff') != 'internet')
    `).all(
      req.userId,
      restrictToInternet ? 1 : 0,
      hideInternet ? 1 : 0,
    );
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Свой текущий профиль целиком, включая роль — регулярные пользовательские
// токены не имеют срока действия и не переиздаются автоматически, так что
// это единственный способ подтянуть поля, появившиеся уже после логина
// (например, role), не заставляя человека перелогиниваться вручную.
router.get('/me', verifyToken, (req, res) => {
  try {
    clearExpiredStatuses();
    const user = db.prepare(`
      SELECT u.*, d.name AS department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?
    `).get(req.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    res.json({
      id: user.id,
      username: user.username,
      display_name: user.display_name || user.username,
      avatar_path: user.avatar_path || null,
      // Свои обои под лентой сообщений — общие на все чаты этого человека.
      chat_background_path: user.chat_background_path || null,
      bio: user.bio || '',
      phone: user.phone || '',
      department: user.department_name || '',
      department_id: user.department_id || null,
      position: user.position || '',
      birth_date: user.birth_date || '',
      role: user.role || null,
      muted: !!user.muted,
      account_type: user.account_type || 'staff',
      status_preset: user.status_preset || null,
      status_custom: user.status_custom || null,
      status_expires_at: user.status_expires_at || null,
      created_at: user.created_at || null,
      // Личный чат «для себя»: его chat_id и название, заданное в панели.
      // Отдаём отсюда, чтобы клиенту не понадобился отдельный запрос ради
      // одной строки — этот ответ он и так забирает при каждом входе.
      self_chat_id: selfChatId(user.id),
      self_chat_name: getSelfChatName(),
      // Базовые реакции — тоже настройка на всю организацию, и нужна клиенту
      // сразу при открытии чата, а не отдельным запросом.
      reaction_emoji: getReactionEmoji(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Редактировать свой профиль (имя пользователя и/или пароль).
// Аккаунты, вошедшие через МИРАС, тут не редактируются — их логин/пароль
// живут на стороне МИРАС, а не в локальной таблице users.
router.put('/me', verifyToken, (req, res) => {
  try {
    if (req.tokenSource === 'miras') {
      return res.status(403).json({ error: 'Профиль этого аккаунта управляется через МИРАС' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const currentPassword = String(req.body.currentPassword || '');

    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    const nextUsername = String(req.body.username || '').trim();
    const nextPassword = String(req.body.password || '');

    const updates = [];
    const params = [];

    if (nextUsername && nextUsername !== user.username) {
      if (isReservedLogin(nextUsername) || !isValidLogin(nextUsername)) {
        return res.status(400).json({ error: 'Логин: 5-32 символов, латиница, цифры и подчёркивание, должен начинаться с буквы' });
      }

      const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(nextUsername, user.id);

      if (existing) {
        return res.status(400).json({ error: 'Это имя уже занято' });
      }

      updates.push('username = ?');
      params.push(nextUsername);
    }

    if (nextPassword) {
      if (!isValidPassword(nextPassword)) {
        return res.status(400).json({ error: 'Пароль: не короче 5 символов и без кириллицы' });
      }

      updates.push('password = ?');
      params.push(bcrypt.hashSync(nextPassword, 10));
    }

    if (req.body.display_name !== undefined) {
      const nextDisplayName = String(req.body.display_name).trim();
      if (!isValidDisplayName(nextDisplayName)) {
        return res.status(400).json({ error: 'Имя: от 2 до 64 символов' });
      }
      updates.push('display_name = ?');
      params.push(nextDisplayName);
    }

    if (req.body.bio !== undefined) {
      const nextBio = String(req.body.bio || '').trim();
      if (!isValidBio(nextBio)) {
        return res.status(400).json({ error: 'О себе: не длиннее 160 символов' });
      }
      updates.push('bio = ?');
      params.push(nextBio);
    }

    if (req.body.phone !== undefined) {
      const nextPhone = String(req.body.phone || '').trim();
      if (!isValidPhone(nextPhone)) {
        return res.status(400).json({ error: 'Некорректный номер телефона' });
      }
      updates.push('phone = ?');
      params.push(nextPhone);
    }

    // Отдел сюда намеренно не принимается. Его назначает администратор в
    // панели: отделами приглашают на события, и возможность записать себя в
    // чужой отдел означала бы возможность самому себе выдать доступ к чужим
    // встречам. В профиле отдел только показывается.

    if (req.body.position !== undefined) {
      const nextPosition = String(req.body.position || '').trim();
      if (!isValidShortText(nextPosition)) {
        return res.status(400).json({ error: 'Должность: не длиннее 100 символов' });
      }
      updates.push('position = ?');
      params.push(nextPosition);
    }

    if (req.body.birth_date !== undefined) {
      const nextBirthDate = String(req.body.birth_date || '').trim();
      if (!isValidBirthDate(nextBirthDate)) {
        return res.status(400).json({ error: 'Некорректная дата рождения' });
      }
      updates.push('birth_date = ?');
      params.push(nextBirthDate);
    }

    if (updates.length > 0) {
      params.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.phone,
             u.department_id, d.name AS department, u.position, u.birth_date
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?
    `).get(user.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Пресетами фиксированным набором, а не свободным текстом с клиента: иначе
// эмодзи/подпись для каждого пресета пришлось бы хранить в базе и держать в
// синхроне на всех платформах — так они живут только в клиенте (STATUS_PRESETS).
const STATUS_PRESETS = new Set(['vacation', 'lunch', 'sick', 'dayoff']);

// Смена статуса — часто нажимаемое действие (в отпуск/с обеда туда-обратно),
// поэтому отдельная лёгкая ручка без currentPassword, в отличие от /me.
// Срок действия статуса ограничен сверху: «до» дальше пары недель — это уже
// не статус, а профильная строчка, и человек про неё забудет, а коллеги будут
// видеть неправду. Снимаем истёкшие лениво (clearExpiredStatuses).
const STATUS_MAX_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

function parseStatusExpiry(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { error: 'Некорректный срок статуса' };
  if (parsed <= Date.now()) return { error: 'Срок статуса уже прошёл' };
  if (parsed > Date.now() + STATUS_MAX_DURATION_MS) return { error: 'Срок статуса — не больше двух недель' };
  return { value: Math.round(parsed) };
}

router.put('/me/status', verifyToken, (req, res) => {
  try {
    const custom = String(req.body.status_custom || '').trim();
    const expiry = parseStatusExpiry(req.body.status_expires_at);
    if (expiry.error) return res.status(400).json({ error: expiry.error });

    if (custom) {
      if (custom.length > 60) {
        return res.status(400).json({ error: 'Статус: не длиннее 60 символов' });
      }
      db.prepare('UPDATE users SET status_preset = NULL, status_custom = ?, status_expires_at = ? WHERE id = ?')
        .run(custom, expiry.value, req.userId);
      return res.json({ status_preset: null, status_custom: custom, status_expires_at: expiry.value });
    }

    const preset = req.body.status_preset ? String(req.body.status_preset) : null;
    if (preset !== null && !STATUS_PRESETS.has(preset)) {
      return res.status(400).json({ error: 'Неизвестный статус' });
    }

    // Статус сняли — срок вместе с ним, иначе он пережил бы следующий
    // бессрочный статус и снял бы его в неожиданный момент.
    const expiresAt = preset === null ? null : expiry.value;
    db.prepare('UPDATE users SET status_preset = ?, status_custom = NULL, status_expires_at = ? WHERE id = ?')
      .run(preset, expiresAt, req.userId);
    res.json({ status_preset: preset, status_custom: null, status_expires_at: expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Загрузить/заменить фото профиля. Новый клиент заранее готовит вертикальный
// кадр 3:4, но сервер всё равно не доверяет размеру входа: поворачивает по EXIF,
// ограничивает габариты и перекодирует в JPEG. В квадрат здесь НЕ режем — один
// файл нужен и полному профилю, и круглому аватару.
router.post('/me/avatar', verifyToken, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp)' });
    }

    try {
      const filename = `user_${req.userId}_${Date.now()}.jpg`;
      const outputPath = path.join(userStorage.userDir(req.userId, 'avatar'), filename);

      await sharp(req.file.buffer)
        .rotate() // учитываем EXIF-ориентацию с телефонных камер
        .resize({
          width: PROFILE_PHOTO_MAX_WIDTH,
          height: PROFILE_PHOTO_MAX_HEIGHT,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: AVATAR_JPEG_QUALITY })
        .toFile(outputPath);

      const user = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.userId);
      const avatarPath = userStorage.publicPath(req.userId, 'avatar', filename);

      db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(avatarPath, req.userId);
      if (user && user.avatar_path && user.avatar_path !== avatarPath) {
        deleteAvatarFile(user.avatar_path);
      }

      res.json({ avatar_path: avatarPath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

/**
 * Загрузить свои обои под ленту сообщений.
 *
 * Исходник не храним никогда: с телефона приходит снимок на несколько мегабайт,
 * а обои — это фон за текстом, где разница между исходным качеством и сжатым
 * не видна вовсе. При сотне сотрудников разница между «как прислали» и
 * «сжатым» — это гигабайты на диске против десятков мегабайт.
 *
 * Размер подобран под вертикальный кадр с телефона: лента сообщений всегда
 * выше своей ширины, и обои растягиваются по ней с обрезкой боков (cover).
 */
router.post('/me/chat-background', verifyToken, (req, res) => {
  backgroundUpload.single('background')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp)' });
    }

    try {
      const filename = `bg_${req.userId}_${Date.now()}.webp`;
      await sharp(req.file.buffer)
        .rotate() // EXIF-ориентация с телефонных камер, иначе кадр ляжет боком
        .resize(BACKGROUND_MAX_WIDTH, BACKGROUND_MAX_HEIGHT, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: BACKGROUND_QUALITY })
        .toFile(path.join(userStorage.userDir(req.userId, 'wallpaper'), filename));

      const user = db.prepare('SELECT chat_background_path FROM users WHERE id = ?').get(req.userId);
      const backgroundPath = userStorage.publicPath(req.userId, 'wallpaper', filename);

      db.prepare('UPDATE users SET chat_background_path = ? WHERE id = ?')
        .run(backgroundPath, req.userId);
      // Имя всегда новое (в нём время), поэтому прежний файл больше не нужен
      // никому: на него не ссылается ни одно сообщение, в отличие от картинок
      // в переписке.
      if (user && user.chat_background_path && user.chat_background_path !== backgroundPath) {
        deleteUploadedFile(user.chat_background_path);
      }

      res.json({ chat_background_path: backgroundPath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

router.delete('/me/chat-background', verifyToken, (req, res) => {
  try {
    const user = db.prepare('SELECT chat_background_path FROM users WHERE id = ?').get(req.userId);
    db.prepare('UPDATE users SET chat_background_path = NULL WHERE id = ?').run(req.userId);
    if (user && user.chat_background_path) deleteUploadedFile(user.chat_background_path);
    res.json({ chat_background_path: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Убрать аватар — возврат к сгенерированной заглушке с инициалами
router.delete('/me/avatar', verifyToken, (req, res) => {
  try {
    const user = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.userId);
    db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.userId);
    if (user && user.avatar_path) deleteAvatarFile(user.avatar_path);
    res.json({ avatar_path: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удалить свой собственный аккаунт
router.delete('/me', verifyToken, (req, res) => {
  try {
    const result = archiveAndDeleteUser(req.userId, { allowMirror: false });

    if (!result) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;