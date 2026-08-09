const db = require('../db');
const { isParticipant, selfChatId } = require('./chatParticipants');

const RECENT_CHAT_LIMIT = 8;

function touchRecentChat(userId, chatId, openedAt = Date.now()) {
  if (!chatId || chatId === 'general' || !isParticipant(chatId, userId)) return false;

  db.prepare(`
    INSERT INTO chat_recent_openings (user_id, chat_id, last_opened_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET last_opened_at = excluded.last_opened_at
  `).run(Number(userId), String(chatId), Number(openedAt));
  return true;
}

function listRecentChats(userId, limit = RECENT_CHAT_LIMIT) {
  const ownChatId = selfChatId(userId);
  const rows = db.prepare(`
    SELECT r.chat_id, r.last_opened_at
    FROM chat_recent_openings r
    WHERE r.user_id = ?
      AND r.chat_id != 'general'
      AND (
        r.chat_id = ?
        OR EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.chat_id = r.chat_id AND m.sender_id = r.user_id
        )
      )
    ORDER BY r.last_opened_at DESC
  `).all(Number(userId), ownChatId);

  const result = [];
  for (const row of rows) {
    // Человек мог выйти из группы после того, как открывал её. Не выдаём
    // устаревший ярлык, который всё равно нельзя открыть.
    if (!isParticipant(row.chat_id, userId)) continue;
    result.push({ chat_id: row.chat_id, last_opened_at: row.last_opened_at });
    if (result.length >= limit) break;
  }
  return result;
}

module.exports = { RECENT_CHAT_LIMIT, touchRecentChat, listRecentChats };
