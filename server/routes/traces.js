const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isParticipant } = require('../services/chatParticipants');
const { listTraces, normalizeNote, resolveOrigin, setTrace } = require('../services/traces');

const router = express.Router();

const KINDS = ['all', 'messages', 'files', 'images', 'links', 'notes'];

// Список своих Следов. Содержимое подмешивается живым и только там, где на него
// есть право, — в самом следе его не хранится (docs/decisions/traces.md).
router.get('/', verifyToken, (req, res) => {
  try {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'all';
    res.json({ items: listTraces(req.userId, { kind }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Приватная заметка к следу. Своя и только своя: ни счётчик, ни чужие следы
// она не трогает, поэтому и отдельного события никому не уходит.
router.put('/:messageId/note', verifyToken, (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.messageId, 10);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Некорректное сообщение' });

    const origin = resolveOrigin(messageId);
    if (!origin) return res.status(404).json({ error: 'Сообщение не найдено' });

    const existing = db.prepare(
      'SELECT origin_chat_id FROM message_traces WHERE origin_message_id = ? AND user_id = ?'
    ).get(origin.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'След не найден' });

    setTrace(origin.id, existing.origin_chat_id, req.userId, req.body?.note);
    return res.json({ note: normalizeNote(req.body?.note) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * Куда вести по «Найти след».
 *
 * Отдельная ручка, а не поле в списке: право проверяется в МОМЕНТ перехода, и
 * ответ у каждого из четырёх состояний свой. Клиенту нужен не просто адрес, а
 * понятная причина, если идти некуда.
 */
router.get('/:messageId/origin', verifyToken, (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.messageId, 10);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Некорректное сообщение' });

    const row = db.prepare(
      'SELECT id, chat_id, deleted, thread_root_id FROM messages WHERE id = ?'
    ).get(messageId);
    if (!row || row.deleted) return res.json({ state: 'cleaned' });

    const hidden = db.prepare(
      'SELECT 1 FROM message_hidden WHERE message_id = ? AND user_id = ?'
    ).get(row.id, req.userId) !== undefined;
    if (hidden) return res.json({ state: 'hidden' });

    if (!isParticipant(row.chat_id, req.userId)) return res.json({ state: 'forbidden' });

    // Ответ ветки вырезан из ленты во всех выдачах истории (thread_root_id IS
    // NULL), и окно вокруг него привело бы в переписку без искомого сообщения.
    // Поэтому туда ведём через саму ветку, а не через ленту.
    return res.json({
      state: 'ok',
      chat_id: row.chat_id,
      message_id: row.id,
      thread_root_id: row.thread_root_id || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
