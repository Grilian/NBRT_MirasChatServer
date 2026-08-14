const db = require('../db');
const { isParticipant, participantsForChatId, parseAdminChatId } = require('./chatParticipants');
const { reactionsForMessages } = require('./reactions');
const { attachPollsToMessages } = require('./polls');
const { isSharedChat, markRead } = require('./readReceipts');

class ThreadError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function rootForUser(rootId, userId) {
  const root = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_path
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = ? AND m.thread_root_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM thread_hidden th
        WHERE th.root_message_id = m.id AND th.user_id = ?
      )
  `).get(Number(rootId), Number(userId));
  if (!root || root.deleted) throw new ThreadError('thread_not_found', 'Ветка недоступна', 404);
  if (!isParticipant(root.chat_id, userId)) throw new ThreadError('thread_forbidden', 'Нет доступа к ветке', 403);
  return root;
}

function sanitizeMessage(message) {
  if (!message || !message.deleted) return message;
  return {
    ...message, text: '', file_path: null, file_width: null, file_height: null,
    sticker_id: null, sticker_fallback: null,
  };
}

function threadSummary(rootId, userId) {
  const hidden = db.prepare(
    'SELECT 1 FROM thread_hidden WHERE root_message_id = ? AND user_id = ?'
  ).get(Number(rootId), Number(userId));
  if (hidden) return { reply_count: 0, unread_count: 0, last_reply_at: null, recent_authors: [] };

  const replies = db.prepare(`
    SELECT m.id, m.sender_id, m.created_at, u.username, u.display_name, u.avatar_path,
           (CASE
              WHEN root.chat_id = 'general' OR root.chat_id GLOB 'group_[0-9]*'
                THEN mr.message_id IS NULL
              ELSE m.status != 'read'
            END AND m.sender_id != ?) AS unread
    FROM messages m
    JOIN messages root ON root.id = m.thread_root_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
    WHERE m.thread_root_id = ? AND m.deleted = 0
      AND NOT EXISTS (
        SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?
      )
    ORDER BY m.id DESC
  `).all(Number(userId), Number(userId), Number(rootId), Number(userId));

  const recentAuthors = [];
  const seen = new Set();
  for (const reply of replies) {
    if (seen.has(reply.sender_id)) continue;
    seen.add(reply.sender_id);
    recentAuthors.push({
      id: Number(reply.sender_id),
      username: reply.username,
      display_name: reply.display_name,
      avatar_path: reply.avatar_path,
    });
    if (recentAuthors.length === 2) break;
  }

  return {
    reply_count: replies.length,
    unread_count: replies.reduce((sum, reply) => sum + (reply.unread ? 1 : 0), 0),
    last_reply_at: replies.length ? replies[0].created_at : null,
    recent_authors: recentAuthors,
  };
}

function attachThreadSummaries(messages, userId) {
  for (const message of messages || []) {
    if (!message.deleted && !message.thread_root_id) {
      message.thread = threadSummary(message.id, userId);
    }
  }
  return messages;
}

function chatMeta(chatId, userId) {
  if (chatId === 'general') return { name: 'Общий чат', kind: 'general', avatar_path: null };
  const groupMatch = String(chatId).match(/^group_(\d+)$/);
  if (groupMatch) {
    const group = db.prepare('SELECT name FROM chat_groups WHERE id = ?').get(Number(groupMatch[1]));
    return { name: group?.name || 'Группа', kind: 'group', avatar_path: null };
  }
  if (/^self_\d+$/.test(String(chatId))) return { name: 'Избранное', kind: 'self', avatar_path: null };
  if (parseAdminChatId(chatId)) return { name: 'Администратор', kind: 'personal', avatar_path: null };
  const participants = participantsForChatId(chatId) || [];
  const otherId = participants.find((id) => Number(id) !== Number(userId)) || participants[0];
  const other = otherId
    ? db.prepare('SELECT username, display_name, avatar_path FROM users WHERE id = ?').get(Number(otherId))
    : null;
  return {
    name: other ? (other.display_name || other.username) : 'Чат',
    kind: 'personal',
    avatar_path: other?.avatar_path || null,
  };
}

function listThreadsForUser(userId, requestedLimit) {
  const numericUserId = Number(userId);
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(1000, parsedLimit)
    : null;
  // Список веток сначала сужается до СВОИХ (корень мой либо я в нём отвечал), и
  // только потом для каждой ищется последний ответ. Раньше порядок был
  // обратным: коррелированный подзапрос «последний ответ» выполнялся для
  // каждого корневого сообщения архива, а участие проверялось после него. На
  // 28 тыс. сообщений это давало 985 мс на один вызов — при том, что вызывает
  // его каждый участник чата на каждый ответ в любой ветке. С отбором в CTE
  // тот же результат считается за 2 мс.
  const rows = db.prepare(`
    WITH my_roots(root_id) AS (
      SELECT id FROM messages
      WHERE sender_id = ? AND thread_root_id IS NULL AND deleted = 0
      UNION
      SELECT DISTINCT thread_root_id FROM messages
      WHERE sender_id = ? AND thread_root_id IS NOT NULL
    )
    SELECT root.id AS root_id, root.chat_id,
           root.text AS root_text, root.file_path AS root_file_path,
           root.sticker_id AS root_sticker_id, root.sticker_fallback AS root_sticker_fallback,
           root.created_at AS root_created_at, root.sender_id AS root_sender_id,
           ru.username AS root_username, ru.display_name AS root_display_name,
           ru.avatar_path AS root_avatar_path,
           latest.id AS last_reply_id, latest.text AS last_reply_text,
           latest.file_path AS last_reply_file_path,
           latest.sticker_id AS last_reply_sticker_id, latest.sticker_fallback AS last_reply_sticker_fallback,
           latest.created_at AS last_reply_at,
           latest.sender_id AS last_reply_sender_id,
           lu.username AS last_reply_username, lu.display_name AS last_reply_display_name,
           lu.avatar_path AS last_reply_avatar_path
    FROM my_roots
    JOIN messages root ON root.id = my_roots.root_id
      AND root.thread_root_id IS NULL AND root.deleted = 0
    JOIN users ru ON ru.id = root.sender_id
    JOIN messages latest ON latest.id = (
      SELECT reply.id FROM messages reply
      WHERE reply.thread_root_id = root.id AND reply.deleted = 0
        AND NOT EXISTS (
          SELECT 1 FROM message_hidden mh
          WHERE mh.message_id = reply.id AND mh.user_id = ?
        )
      ORDER BY reply.id DESC LIMIT 1
    )
    JOIN users lu ON lu.id = latest.sender_id
    WHERE NOT EXISTS (
      SELECT 1 FROM thread_hidden th
      WHERE th.root_message_id = root.id AND th.user_id = ?
    )
    ORDER BY latest.id DESC
  `).all(numericUserId, numericUserId, numericUserId, numericUserId);

  const accessibleRows = rows.filter((row) => isParticipant(row.chat_id, numericUserId));
  const selectedRows = limit === null ? accessibleRows : accessibleRows.slice(0, limit);
  return selectedRows.map((row) => ({
    root_id: Number(row.root_id),
    chat_id: row.chat_id,
    chat: chatMeta(row.chat_id, numericUserId),
    root: {
      id: Number(row.root_id), text: row.root_text || '', file_path: row.root_file_path || null,
      sticker_id: row.root_sticker_id || null, sticker_fallback: row.root_sticker_fallback || null,
      created_at: row.root_created_at, sender_id: Number(row.root_sender_id),
      username: row.root_username, display_name: row.root_display_name, avatar_path: row.root_avatar_path,
    },
    last_reply: {
      id: Number(row.last_reply_id), text: row.last_reply_text || '', file_path: row.last_reply_file_path || null,
      sticker_id: row.last_reply_sticker_id || null, sticker_fallback: row.last_reply_sticker_fallback || null,
      created_at: row.last_reply_at, sender_id: Number(row.last_reply_sender_id),
      username: row.last_reply_username, display_name: row.last_reply_display_name,
      avatar_path: row.last_reply_avatar_path,
    },
    summary: threadSummary(row.root_id, numericUserId),
  }));
}

function getThread(rootId, userId) {
  const root = sanitizeMessage(rootForUser(rootId, userId));
  const replies = db.prepare(`
    SELECT m.id, m.chat_id, m.thread_root_id, m.text, m.file_path, m.file_width,
           m.file_height, m.sticker_id, m.sticker_fallback, m.sender_id, m.created_at, m.status, m.edited_at,
           m.deleted, m.client_message_id, m.reply_to_id,
           u.username, u.display_name, u.avatar_path,
           rm.text AS reply_to_text, rm.file_path AS reply_to_file,
           rm.sticker_fallback AS reply_to_sticker_fallback,
           rm.deleted AS reply_to_deleted,
           COALESCE(ru.display_name, ru.username) AS reply_to_author
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.sender_id
    WHERE m.thread_root_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?
      )
    ORDER BY m.id ASC
  `).all(Number(rootId), Number(userId)).map(sanitizeMessage);

  attachPollsToMessages([root, ...replies], userId);
  const reactions = reactionsForMessages([root.id, ...replies.map((m) => m.id)]);
  root.reactions = reactions[root.id] || [];
  for (const reply of replies) reply.reactions = reactions[reply.id] || [];
  return { root, replies, summary: threadSummary(rootId, userId) };
}

function markThreadRead(rootId, userId) {
  const root = rootForUser(rootId, userId);
  const unreadCondition = isSharedChat(root.chat_id) ? 'mr.message_id IS NULL' : "m.status != 'read'";
  const unread = db.prepare(`
    SELECT m.id FROM messages m
    LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
    WHERE m.thread_root_id = ? AND m.deleted = 0 AND m.sender_id != ?
      AND ${unreadCondition}
  `).all(Number(userId), Number(rootId), Number(userId));
  const messageIds = unread.map((row) => Number(row.id));
  const affected = markRead(Number(userId), root.chat_id, messageIds);
  return { root, messageIds: affected, summary: threadSummary(rootId, userId) };
}

function hideThread(rootId, userId) {
  const root = rootForUser(rootId, userId);
  db.prepare(`
    INSERT OR IGNORE INTO thread_hidden (root_message_id, user_id, hidden_at)
    VALUES (?, ?, ?)
  `).run(root.id, Number(userId), Date.now());
  return root;
}

function softDeleteThread(rootId, deletedBy) {
  const now = Date.now();
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE messages SET deleted = 1, deleted_at = ?, deleted_by = ?
      WHERE id = ? OR thread_root_id = ?
    `).run(now, Number(deletedBy), Number(rootId), Number(rootId));
  });
  transaction();
}

module.exports = {
  ThreadError,
  rootForUser,
  threadSummary,
  attachThreadSummaries,
  listThreadsForUser,
  getThread,
  markThreadRead,
  hideThread,
  softDeleteThread,
};
