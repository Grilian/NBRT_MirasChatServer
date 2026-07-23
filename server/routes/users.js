const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isValidLogin, isReservedLogin, isValidPassword, isValidDisplayName, isValidPhone, isValidBio } = require('../utils/validators');
const router = express.Router();

const AVATARS_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });

const AVATAR_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATARS_DIR),
    filename: (req, file, cb) => cb(null, `user_${req.userId}_${Date.now()}.${AVATAR_MIME_EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!AVATAR_MIME_EXT[file.mimetype]),
});

// Удаляем файл аватара с диска — best-effort, отсутствие файла не ошибка.
function deleteAvatarFile(avatarPath) {
  if (!avatarPath) return;
  const abs = path.join(__dirname, '..', avatarPath.replace(/^\//, ''));
  fs.unlink(abs, () => {});
}

// Полное удаление локального аккаунта: сообщения, избранное, комментарии,
// сама учётная запись.
function deleteLocalUserById(id) {
  const user = db.prepare('SELECT id, username, avatar_path FROM users WHERE id = ?').get(id);

  if (!user) {
    return null;
  }

  if (user.username.startsWith('miras_')) {
    throw new Error('Нельзя удалить служебную учётную запись');
  }

  const tx = db.transaction(() => {
    // "sender_id = id" ловит только сообщения, которые отправил сам
    // пользователь — но в тредах "1 на 1" с админом или другим сотрудником
    // собеседник тоже писал туда со своим sender_id. Такие треды целиком
    // принадлежат этому пользователю (в отличие от "general", это общий
    // канал на всех, его не трогаем), поэтому чистим их по chat_id целиком.
    const idStr = String(id);

    const relatedChatIds = db.prepare('SELECT DISTINCT chat_id FROM messages')
      .all()
      .map(row => row.chat_id)
      .filter(chatId => {
        if (chatId.startsWith('miras_admin_')) {
          return chatId.endsWith('_' + idStr);
        }
        const match = chatId.match(/^chat_(\d+)_(\d+)$/);
        return !!match && (match[1] === idStr || match[2] === idStr);
      });

    if (relatedChatIds.length) {
      const placeholders = relatedChatIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE chat_id IN (${placeholders})`).run(...relatedChatIds);
    }

    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(id);
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_comments WHERE user_id = ? OR target_user_id = ?').run(id, id);
    db.prepare('DELETE FROM contacts WHERE user_id = ? OR contact_user_id = ?').run(id, id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  tx();
  deleteAvatarFile(user.avatar_path);

  return user;
}

// Получить всех пользователей (кроме текущего).
// miras_* — служебные зеркала админов МИРАС для маршрутизации сообщений,
// в списке реальных сотрудников их быть не должно.
router.get('/', verifyToken, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_path, u.group_id, g.name AS group_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id != ?
        AND u.username NOT LIKE 'miras\_%' ESCAPE '\\'
    `).all(req.userId);
    res.json(users);
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

    if (updates.length > 0) {
      params.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT id, username, display_name, avatar_path, bio, phone FROM users WHERE id = ?').get(user.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Загрузить/заменить свой аватар
router.post('/me/avatar', verifyToken, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp)' });
    }

    try {
      const user = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.userId);
      const avatarPath = `/uploads/avatars/${req.file.filename}`;

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
    const user = deleteLocalUserById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;