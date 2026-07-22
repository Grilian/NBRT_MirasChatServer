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

    // miras_* — служебные зеркала админов МИРАС (создаются для маршрутизации
    // сообщений), а не реальные сотрудники MirasChat — в списке для Мираса
    // им делать нечего, иначе админ увидит "диалоги" сам с собой.
    const users = db.prepare(`
      SELECT id, username, created_at
      FROM users
      WHERE username NOT LIKE 'miras\_%' ESCAPE '\\'
      ORDER BY username ASC
    `).all();

    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;