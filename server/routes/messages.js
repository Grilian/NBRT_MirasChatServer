const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Последнее сообщение по каждому chat_id — для превью в списке диалогов.
// Не сузили выборку до "чатов текущего пользователя": id чатов (chat_<a>_<b>,
// miras_admin_<login>_<id>) и так завязаны на конкретного пользователя, так что
// лишние записи просто не находят соответствия в списке на клиенте.
router.get('/meta/last', verifyToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT m.chat_id, m.text, m.created_at
      FROM messages m
      INNER JOIN (
        SELECT chat_id, MAX(id) AS max_id
        FROM messages
        GROUP BY chat_id
      ) latest ON latest.chat_id = m.chat_id AND latest.max_id = m.id
    `).all();

    const result = {};
    rows.forEach(row => {
      result[row.chat_id] = { chat_id: row.chat_id, text: row.text, created_at: row.created_at };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить историю чата с пагинацией
router.get('/:chatId', verifyToken, (req, res) => {
  try {
    const chatId = req.params.chatId;
    const limit = parseInt(req.query.limit) || 50; // По умолчанию 50 сообщений
    const offset = parseInt(req.query.offset) || 0;

    const messages = db.prepare(`
      SELECT m.id, m.text, m.sender_id, m.created_at, m.status, m.edited_at, m.deleted, u.username
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

module.exports = router;