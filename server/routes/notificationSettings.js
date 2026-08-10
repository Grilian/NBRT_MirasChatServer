const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isParticipant } = require('../services/chatParticipants');
const { NotificationPolicyError, isChatMuted, setChatMuted } = require('../services/notificationPolicy');

const router = express.Router();

router.get('/', verifyToken, (req, res) => {
  const rows = db.prepare(`
    SELECT chat_id FROM chat_notification_settings
    WHERE user_id = ? AND muted = 1
    ORDER BY updated_at DESC
  `).all(req.userId);
  res.json({ muted_chat_ids: rows.map((row) => row.chat_id) });
});

router.get('/:chatId', verifyToken, (req, res) => {
  const chatId = String(req.params.chatId || '');
  if (!isParticipant(chatId, req.userId)) return res.status(403).json({ error: 'chat_forbidden' });
  res.json({ chat_id: chatId, muted: isChatMuted(req.userId, chatId) });
});

router.put('/:chatId', verifyToken, (req, res) => {
  try {
    const chatId = String(req.params.chatId || '');
    if (!isParticipant(chatId, req.userId)) return res.status(403).json({ error: 'chat_forbidden' });
    if (typeof req.body?.muted !== 'boolean') return res.status(400).json({ error: 'muted_must_be_boolean' });
    const result = setChatMuted(req.userId, chatId, req.body.muted);
    req.app.get('io')?.to(`user:${req.userId}`).emit('notification_settings_changed', result);
    res.json(result);
  } catch (error) {
    if (error instanceof NotificationPolicyError) return res.status(400).json({ error: error.code });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
