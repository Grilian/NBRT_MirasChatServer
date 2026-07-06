const express = require('express');
const db = require('../db');
const router = express.Router();

// Получить всех пользователей MirasChat (для МИРАС)
router.get('/', (req, res) => {
  try {
    const token = req.headers['x-miras-chat-token'];
    if (String(token || "").trim() !== String(process.env.MIRAS_CHAT_TOKEN || "").trim()) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const users = db.prepare(`
      SELECT id, username, created_at
      FROM users
      ORDER BY username ASC
    `).all();

    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;