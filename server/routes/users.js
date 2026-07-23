const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Полное удаление локального аккаунта: сообщения, избранное, комментарии,
// сама учётная запись.
function deleteLocalUserById(id) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);

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
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  tx();

  return user;
}

// Получить всех пользователей (кроме текущего).
// miras_* — служебные зеркала админов МИРАС для маршрутизации сообщений,
// в списке реальных сотрудников их быть не должно.
router.get('/', verifyToken, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.group_id, g.name AS group_name
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
    let resultUsername = user.username;

    if (nextUsername && nextUsername !== user.username) {
      if (nextUsername.toLowerCase().startsWith('miras_')) {
        return res.status(400).json({ error: 'Это имя пользователя зарезервировано' });
      }

      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(nextUsername, user.id);

      if (existing) {
        return res.status(400).json({ error: 'Это имя уже занято' });
      }

      updates.push('username = ?');
      params.push(nextUsername);
      resultUsername = nextUsername;
    }

    if (nextPassword) {
      if (nextPassword.length < 6) {
        return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
      }

      updates.push('password = ?');
      params.push(bcrypt.hashSync(nextPassword, 10));
    }

    if (updates.length > 0) {
      params.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    res.json({ id: user.id, username: resultUsername });
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