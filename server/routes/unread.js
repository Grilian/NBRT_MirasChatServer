const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isParticipant } = require('../services/chatParticipants');
const router = express.Router();

// Получить количество непрочитанных сообщений для каждого чата
router.get('/', verifyToken, (req, res) => {
  try {
    const currentUserId = req.userId;

    // Непрочитанное — это всё чужое, что не в статусе 'read'. Раньше здесь
    // стояло status = 'delivered', и это молча ломало счётчики в самом важном
    // случае: 'delivered' проставлялся, только если получатель был онлайн в
    // момент отправки (или его клиент успел показать уведомление). Сообщение,
    // пришедшее человеку, пока он оффлайн, навсегда оставалось в статусе
    // 'sent' — то есть при следующем входе он не видел ни бейджа, ни счётчика,
    // хотя сообщение лежало непрочитанным.
    //
    // По всем chat_id в базе, а не только по чатам текущего пользователя:
    // раньше это отдавалось как есть, из-за чего счётчики чужих личных
    // переписок утекали в чужой аккаунт (например, суммарный бейдж показывал
    // число, которого в своих чатах нет). Фильтруем по фактическому участию —
    // та же проверка, что и при рассылке.
    const rows = db.prepare(`
      SELECT chat_id, COUNT(*) AS count
      FROM messages
      WHERE
          sender_id != ?
          AND status != 'read'
          AND (deleted IS NULL OR deleted = 0)
      GROUP BY chat_id
    `).all(currentUserId);

    const unreadCounts = {};
    rows.forEach(row => {
      if (isParticipant(row.chat_id, currentUserId)) {
        unreadCounts[row.chat_id] = row.count;
      }
    });

    res.json(unreadCounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
