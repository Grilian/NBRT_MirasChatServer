const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Получить количество непрочитанных сообщений для каждого чата
router.get('/', verifyToken, (req, res) => {
  try {
    const currentUserId = req.userId;
    
    // Получаем все чаты где есть сообщения от других пользователей не прочитанные нами
    const unread = db.prepare(`
      SELECT
        chat_id,
        COUNT(*) AS count
      FROM messages
      WHERE
          sender_id != ?
          AND status = 'delivered'
      GROUP BY chat_id
    `).all(currentUserId);
    
    // Преобразуем в объект { chat_id: count }
    const unreadCounts = {};
    unread.forEach(row => {
      unreadCounts[row.chat_id] = row.count;
    });
    
    res.json(unreadCounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;