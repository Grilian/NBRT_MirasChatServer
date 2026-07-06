const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Получить всех пользователей (кроме текущего)
router.get('/', verifyToken, (req, res) => {
  try {
    const users = db.prepare('SELECT id, username FROM users WHERE id != ?').all(req.userId);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;