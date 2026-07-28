const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const sharp = require('sharp');
const { isValidLogin, isReservedLogin, isValidPassword, isValidDisplayName, isValidPhone, isValidBio, isValidShortText, isValidBirthDate } = require('../utils/validators');
const { deleteAvatarFile } = require('../utils/files');
const { archiveAndDeleteUser } = require('../services/accountArchive');
const router = express.Router();

const AVATARS_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });

const AVATAR_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX_DIMENSION = 320; // сторона квадрата — достаточно для круглого аватара, не для полноэкранного фото
const AVATAR_JPEG_QUALITY = 80;

// Буфер в памяти, а не сразу на диск — файл нужно сначала прогнать через
// sharp (телефоны присылают многомегабайтные фото, а нужен маленький
// сжатый квадрат), и только потом сохранить готовый результат.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED_MIME.includes(file.mimetype)),
});

// Группа, которую видит даже тип "Интернет", несмотря на общее ограничение
// ниже — иначе им неоткуда узнать, кому написать с просьбой сменить тип
// на "Сотрудник" (сами админов в справочнике иначе не найдут).
const INTERNET_VISIBLE_GROUPS = ['Админы'];

// Получить всех пользователей (кроме текущего) — справочник для поиска.
// miras_* — служебные зеркала админов МИРАС для маршрутизации сообщений,
// в списке реальных сотрудников их быть не должно.
// Тип "Интернет" (незнакомые с улицы, самостоятельная регистрация) видит в
// справочнике только других "Интернет" плюс группу "Админы" (см. выше) — не
// может пробежаться по всем сотрудникам. После того как админ подтвердит его
// как "Сотрудник", видимость открывается на всех.
router.get('/', verifyToken, (req, res) => {
  try {
    const requester = db.prepare('SELECT account_type FROM users WHERE id = ?').get(req.userId);
    const restrictToInternet = requester && requester.account_type === 'internet';
    const visibleGroupPlaceholders = INTERNET_VISIBLE_GROUPS.map(() => '?').join(',');

    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_path, u.group_id, g.name AS group_name,
             u.department_id, d.name AS department
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id != ?
        AND u.username NOT LIKE 'miras\_%' ESCAPE '\\'
        AND (? = 0 OR u.account_type = 'internet' OR g.name IN (${visibleGroupPlaceholders}))
    `).all(req.userId, restrictToInternet ? 1 : 0, ...INTERNET_VISIBLE_GROUPS);
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
      bio: user.bio || '',
      phone: user.phone || '',
      department: user.department_name || '',
      department_id: user.department_id || null,
      position: user.position || '',
      birth_date: user.birth_date || '',
      role: user.role || null,
      muted: !!user.muted,
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

// Загрузить/заменить свой аватар — сжимаем и обрезаем в квадрат перед
// сохранением, вместо того чтобы хранить исходник как есть (с телефонов
// приходят многомегабайтные фото на маленький круглый аватар).
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
      const outputPath = path.join(AVATARS_DIR, filename);

      await sharp(req.file.buffer)
        .rotate() // на случай EXIF-ориентации с телефонных камер — иначе кроп в квадрат может уйти боком
        .resize(AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION, { fit: 'cover' })
        .jpeg({ quality: AVATAR_JPEG_QUALITY })
        .toFile(outputPath);

      const user = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.userId);
      const avatarPath = `/uploads/avatars/${filename}`;

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