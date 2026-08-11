const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isParticipant } = require('../services/chatParticipants');
const router = express.Router();

// Получить количество непрочитанных сообщений для каждого чата
router.get('/', verifyToken, (req, res) => {
  try {
    const currentUserId = req.userId;

    // Счётчик чата — только то, что человек прочитает, открыв сам чат. Ответы
    // веток в ленту чата не попадают (см. thread_root_id IS NULL в истории),
    // поэтому открытие чата их не гасит: клиент шлёт message_read по тем id,
    // что реально есть в ленте. Пока ответы веток входили сюда, бейдж чата
    // после прочтения всей переписки оставался висеть навсегда — снять его
    // можно было, только открыв конкретную ветку, а участник чата, который в
    // этой ветке не отвечал, не видит её даже в списке «Ветки».
    // Непрочитанное веток — отдельный сигнал: плашка под корневым сообщением
    // и раздел «Ветки». Клиент прибавляет его к общему бейджу сам
    // (threadUnreadTotal), поэтому здесь оно учитываться и не должно — иначе
    // одни и те же ответы считались бы дважды.
    const threadVisibilityClause = 'AND m.thread_root_id IS NULL';

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
    //
    // Личные чаты считаем по общему status — там он однозначен (получатель
    // ровно один). Общий чат и группы — по message_reads: у сообщения там
    // несколько получателей, и общий status значит лишь "прочитано хоть
    // кем-то", а не "прочитано мной" — иначе бейдж пропадал бы у всех, как
    // только кто-то один открыл чат.
    // Скрытое лично этим человеком («удалить только у себя») в счётчик не
    // берём: открыть его он всё равно не сможет, а бейдж висел бы навсегда.
    const personalRows = db.prepare(`
      SELECT chat_id, COUNT(*) AS count
      FROM messages m
      WHERE
          sender_id != ?
          AND status != 'read'
          AND (deleted IS NULL OR deleted = 0)
          AND chat_id != 'general'
          ${threadVisibilityClause}
          AND chat_id NOT LIKE 'group\\_%' ESCAPE '\\'
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM thread_hidden th
            WHERE th.root_message_id = COALESCE(m.thread_root_id, m.id) AND th.user_id = ?
          )
      GROUP BY chat_id
    `).all(currentUserId, currentUserId, currentUserId);

    const sharedRows = db.prepare(`
      SELECT m.chat_id, COUNT(*) AS count
      FROM messages m
      LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
      WHERE
          m.sender_id != ?
          AND r.message_id IS NULL
          ${threadVisibilityClause}
          AND (m.deleted IS NULL OR m.deleted = 0)
          AND (m.chat_id = 'general' OR m.chat_id LIKE 'group\\_%' ESCAPE '\\')
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM thread_hidden th
            WHERE th.root_message_id = COALESCE(m.thread_root_id, m.id) AND th.user_id = ?
          )
      GROUP BY m.chat_id
    `).all(currentUserId, currentUserId, currentUserId, currentUserId);

    const unreadCounts = {};
    [...personalRows, ...sharedRows].forEach(row => {
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
