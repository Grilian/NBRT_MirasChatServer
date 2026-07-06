const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Получить избранные чаты пользователя
router.get('/', verifyToken, (req, res) => {
  try {
    const favorites = db.prepare('SELECT chat_id FROM favorites WHERE user_id = ?').all(req.userId);
    res.json(favorites.map(f => f.chat_id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Добавить в избранное
router.post('/', verifyToken, (req, res) => {
  try {
    const { chat_id } = req.body;
    db.prepare('INSERT INTO favorites (user_id, chat_id) VALUES (?, ?)').run(req.userId, chat_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удалить из избранного
router.delete('/:chatId', verifyToken, (req, res) => {
  try {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND chat_id = ?').run(req.userId, req.params.chatId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;