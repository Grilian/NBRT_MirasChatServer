const db = require('../db');

// Следы: осознанное сохранение ПРОИСХОЖДЕНИЯ объекта (docs/decisions/traces.md).
//
// След принадлежит не копии сообщения, а первоисточнику. Поэтому любой id,
// пришедший от клиента, сначала разрешается до origin: наследить можно на
// пересланную копию или на переданный след, а запись всё равно ляжет на то
// сообщение, с которого всё началось.

const MAX_NOTE_LENGTH = 500;

/**
 * Первоисточник сообщения.
 *
 * Цепочка схлопнута при записи (origin_message_id уже указывает на самое
 * начало), поэтому одного шага достаточно и рекурсия не нужна.
 */
function resolveOrigin(messageId) {
  const row = db.prepare(
    'SELECT id, chat_id, origin_message_id FROM messages WHERE id = ?'
  ).get(messageId);
  if (!row) return null;
  if (!row.origin_message_id) return { id: row.id, chat_id: row.chat_id };

  const origin = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(row.origin_message_id);
  // Первоисточник мог исчезнуть вместе с аккаунтом или группой. Тогда следом
  // считается сама копия: она существует, её видно, и вести к ней честнее, чем
  // отказывать в действии.
  return origin || { id: row.id, chat_id: row.chat_id };
}

function normalizeNote(note) {
  if (note === null || note === undefined) return null;
  const trimmed = String(note).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NOTE_LENGTH);
}

function setTrace(originMessageId, originChatId, userId, note) {
  db.prepare(`
    INSERT INTO message_traces (origin_message_id, user_id, origin_chat_id, object_type, note, created_at)
    VALUES (?, ?, ?, 'message', ?, ?)
    ON CONFLICT(origin_message_id, user_id) DO UPDATE SET
      note = excluded.note
  `).run(originMessageId, userId, originChatId, normalizeNote(note), Date.now());
}

function removeTrace(originMessageId, userId) {
  db.prepare('DELETE FROM message_traces WHERE origin_message_id = ? AND user_id = ?')
    .run(originMessageId, userId);
}

function hasTrace(originMessageId, userId) {
  return db.prepare('SELECT 1 FROM message_traces WHERE origin_message_id = ? AND user_id = ?')
    .get(originMessageId, userId) !== undefined;
}

/** Сколько человек наследило это сообщение. Имена наружу не отдаются никогда. */
function traceCount(originMessageId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM message_traces WHERE origin_message_id = ?')
    .get(originMessageId);
  return row ? row.n : 0;
}

/**
 * Счётчики Следов и пересылок пачкой на страницу истории.
 *
 * Два отдельных запроса, а не один с join'ом: это РАЗНЫЕ механики с разными
 * источниками, и смешивать их нельзя (traces.md). Подзапрос на сообщение
 * недопустим — в общем чате десятки тысяч строк.
 */
function countsForMessages(ids, userId) {
  const result = Object.fromEntries(ids.map((id) => [id, { traces: 0, forwards: 0, traced: false }]));
  if (!ids.length) return result;

  const placeholders = ids.map(() => '?').join(',');

  for (const row of db.prepare(`
    SELECT origin_message_id AS id, COUNT(*) AS n,
           MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
    FROM message_traces
    WHERE origin_message_id IN (${placeholders})
    GROUP BY origin_message_id
  `).all(userId, ...ids)) {
    result[row.id].traces = row.n;
    result[row.id].traced = !!row.mine;
  }

  for (const row of db.prepare(`
    SELECT origin_message_id AS id, COUNT(*) AS n
    FROM messages
    WHERE origin_message_id IN (${placeholders}) AND origin_via = 'forward'
    GROUP BY origin_message_id
  `).all(...ids)) {
    result[row.id].forwards = row.n;
  }

  return result;
}

function attachTraceCounts(messages, userId) {
  if (!messages.length) return;
  const counts = countsForMessages(messages.map((m) => m.id), userId);
  for (const message of messages) {
    const row = counts[message.id];
    message.trace_count = row.traces;
    message.forward_count = row.forwards;
    message.traced_by_me = row.traced;
  }
}

module.exports = {
  MAX_NOTE_LENGTH,
  resolveOrigin,
  normalizeNote,
  setTrace,
  removeTrace,
  hasTrace,
  traceCount,
  countsForMessages,
  attachTraceCounts,
};
