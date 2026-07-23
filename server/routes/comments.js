const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Получить все комментарии текущего пользователя
router.get('/', verifyToken, (req, res) => {
  try {
    const comments = db.prepare(`
      SELECT uc.target_user_id, uc.comment, u.username, u.display_name
      FROM user_comments uc
      JOIN users u ON uc.target_user_id = u.id
      WHERE uc.user_id = ?
    `).all(req.userId);

    // Преобразуем в объект { target_user_id: { username, display_name, comment } }
    const commentsMap = {};
    comments.forEach(c => {
      commentsMap[c.target_user_id] = {
        username: c.username,
        display_name: c.display_name,
        comment: c.comment
      };
    });
    
    res.json(commentsMap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Установить/обновить комментарий
router.post('/', verifyToken, (req, res) => {
  try {
    const { target_user_id, comment } = req.body;
    
    db.prepare(`
      INSERT INTO user_comments (user_id, target_user_id, comment) 
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, target_user_id) 
      DO UPDATE SET comment = excluded.comment
    `).run(req.userId, target_user_id, comment);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;