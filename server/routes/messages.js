const express = require('express');
const db = require('../db');
const router = express.Router();

// Получить историю чата
router.get('/:chatId', (req, res) => {
  try {
    const messages = db.prepare(`
      SELECT m.id, m.text, m.sender_id, m.created_at, u.username 
      FROM messages m 
      JOIN users u ON m.sender_id = u.id 
      WHERE m.chat_id = ? 
      ORDER BY m.created_at ASC
    `).all(req.params.chatId);
    res.json(messages);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Отправить сообщение (REST)
router.post('/', (req, res) => {
  try {
    const { chat_id, text } = req.body;
    const sender_id = req.userId; // берем из middleware verifyToken

    const stmt = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)');
    const result = stmt.run(chat_id, sender_id, text);

    // Отправляем в сокет
    const io = req.app.get('io');
    io.emit('chat_message', {
      id: result.lastInsertRowid,
      chat_id, sender_id, text,
      created_at: new Date().toISOString()
    });

    res.json({ id: result.lastInsertRowid, chat_id, sender_id, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;