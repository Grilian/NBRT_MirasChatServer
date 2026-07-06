const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Получить историю чата с пагинацией
router.get('/:chatId', verifyToken, (req, res) => {
  try {
    const chatId = req.params.chatId;
    const limit = parseInt(req.query.limit) || 50; // По умолчанию 50 сообщений
    const offset = parseInt(req.query.offset) || 0;

    const messages = db.prepare(`
      SELECT m.id, m.text, m.sender_id, m.created_at, m.status, u.username 
      FROM messages m 
      JOIN users u ON m.sender_id = u.id 
      WHERE m.chat_id = ? 
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(chatId, limit, offset);

    // Переворачиваем чтобы старые были в начале
    messages.reverse();

    // Проверяем есть ли ещё сообщения
    const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?').get(chatId);
    const hasMore = (offset + messages.length) < totalMessages.count;

    res.json({ messages, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отправить сообщение (REST)
router.post('/', verifyToken, (req, res) => {
  try {
    const { chat_id, text } = req.body;
    const sender_id = req.userId;

    const stmt = db.prepare('INSERT INTO messages (chat_id, sender_id, text, status) VALUES (?, ?, ?, ?)');
    const result = stmt.run(chat_id, sender_id, text, 'sent');

    const io = req.app.get('io');
    io.emit('chat_message', {
      id: result.lastInsertRowid,
      chat_id, sender_id, text,
      status: 'sent',
      created_at: new Date().toISOString()
    });

    res.json({ id: result.lastInsertRowid, chat_id, sender_id, text, status: 'sent' });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

module.exports = router;