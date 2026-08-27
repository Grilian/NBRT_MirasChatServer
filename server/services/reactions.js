const db = require('../db');

// Реакция принадлежит человеку, а не сообщению: под сообщением может стоять
// сколько угодно реакций, но у каждого — ровно одна (PRIMARY KEY на паре
// message_id+user_id). Повторная установка заменяет прежнюю, а не добавляет.

// Эмодзи приходит от клиента и попадает в интерфейс всем участникам чата.
// Набор задаётся в панели (см. appSettings.getReactionEmoji), но сверять с ним
// на каждой установке нельзя: набор меняют, а уже поставленные реакции должны
// пережить это. Поэтому ограничиваем только длину — на случай, если вместо
// эмодзи придёт простыня.
// : + имя до 32 символов + :
const MAX_EMOJI_LENGTH = 34;

function isValidEmoji(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_EMOJI_LENGTH;
}

/** Все реакции сообщения — с людьми, чтобы клиент нарисовал аватары. */
function reactionsFor(messageId) {
  return db.prepare(`
    SELECT r.emoji, r.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_path
    FROM message_reactions r
    JOIN users u ON u.id = r.user_id
    WHERE r.message_id = ?
    ORDER BY r.created_at
  `).all(messageId).map((row) => ({
    emoji: row.emoji,
    created_at: row.created_at,
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name || row.username,
      avatar_path: row.avatar_path || null,
    },
  }));
}

/** То же самое пачкой — для истории чата, чтобы не делать запрос на сообщение. */
function reactionsForMessages(ids) {
  const result = Object.fromEntries(ids.map((id) => [id, []]));
  if (!ids.length) return result;

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT r.message_id, r.emoji, r.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_path
    FROM message_reactions r
    JOIN users u ON u.id = r.user_id
    WHERE r.message_id IN (${placeholders})
    ORDER BY r.created_at
  `).all(...ids);

  for (const row of rows) {
    result[row.message_id].push({
      emoji: row.emoji,
      created_at: row.created_at,
      user: {
        id: row.user_id,
        username: row.username,
        display_name: row.display_name || row.username,
        avatar_path: row.avatar_path || null,
      },
    });
  }
  return result;
}

function setReaction(messageId, userId, emoji) {
  db.prepare(`
    INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user_id) DO UPDATE SET
      emoji = excluded.emoji,
      created_at = excluded.created_at
  `).run(messageId, userId, emoji, Date.now());
}

function removeReaction(messageId, userId) {
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
}

module.exports = { isValidEmoji, reactionsFor, reactionsForMessages, setReaction, removeReaction };
