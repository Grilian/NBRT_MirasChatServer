const db = require('../db');
const { isParticipant } = require('./chatParticipants');
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
  return { ...message, text: '', file_path: null, file_width: null, file_height: null };
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

function getThread(rootId, userId) {
  const root = sanitizeMessage(rootForUser(rootId, userId));
  const replies = db.prepare(`
    SELECT m.id, m.chat_id, m.thread_root_id, m.text, m.file_path, m.file_width,
           m.file_height, m.sender_id, m.created_at, m.status, m.edited_at,
           m.deleted, m.client_message_id, m.reply_to_id,
           u.username, u.display_name, u.avatar_path,
           rm.text AS reply_to_text, rm.file_path AS reply_to_file,
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
  getThread,
  markThreadRead,
  hideThread,
  softDeleteThread,
};
