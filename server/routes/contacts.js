const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Список контактов текущего пользователя (то, что показывается в чат-листе) —
// та же форма ответа, что и /api/users (справочник), чтобы клиент мог просто
// сменить источник данных без изменения формы.
router.get('/', verifyToken, (req, res) => {
  try {
    const contacts = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_path, u.bio, u.phone,
             u.department, u.position, u.birth_date, u.group_id, g.name AS group_name,
             u.status_preset, u.status_custom
      FROM contacts c
      JOIN users u ON u.id = c.contact_user_id
      LEFT JOIN groups g ON g.id = u.group_id
      WHERE c.user_id = ?
    `).all(req.userId);
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Добавить контакт — односторонне, без подтверждения второй стороны
// (обратное направление появляется само при первом обмене сообщением, см.
// автоподписку в обработчике chat_message).
router.post('/:userId', verifyToken, (req, res) => {
  try {
    const targetId = Number(req.params.userId);
    if (!targetId || targetId === req.userId) {
      return res.status(400).json({ error: 'Некорректный пользователь' });
    }

    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
    if (!target || target.username.startsWith('miras_')) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)').run(req.userId, targetId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Убрать из своего списка — не трогает историю сообщений и не мешает
// собеседнику написать снова (это не блокировка).
router.delete('/:userId', verifyToken, (req, res) => {
  try {
    db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(req.userId, Number(req.params.userId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
