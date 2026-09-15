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

/**
 * Вид сохранённого объекта — для фильтров раздела.
 *
 * Считается по самому сообщению, а не хранится в следе: сообщение могут
 * отредактировать, а вложение убрать, и запомненный при сохранении вид разошёлся
 * бы с тем, что человек видит сейчас.
 */
function kindOf(row) {
  if (!row) return 'messages';
  if (row.file_path) return 'images';
  if (row.document_path) return 'files';
  if (row.text && /https?:\/\//i.test(row.text)) return 'links';
  return 'messages';
}

/**
 * Следы человека — с ЖИВЫМ состоянием каждого.
 *
 * Содержимое читается из messages в момент запроса и только при праве его
 * видеть: в самом следе содержимого нет (см. схему), и это не оптимизация, а
 * то, что не даёт удалённому и закрытому утечь через список.
 *
 * Состояний четыре:
 *   ok        — источник на месте, доступ есть;
 *   cleaned   — «след подчищен»: строки нет вовсе либо стоит deleted;
 *   hidden    — человек скрыл это сообщение У СЕБЯ. Отдельно от cleaned:
 *               у остальных оно живо, и валить это в «удалено» значило бы
 *               соврать. Скрытое кем-то ДРУГИМ на этот след не влияет никак;
 *   forbidden — доступа к исходному месту больше нет (вышел из группы).
 */
function listTraces(userId, { kind = 'all' } = {}) {
  const { isParticipant } = require('./chatParticipants');
  const { chatMeta } = require('./threads');

  const rows = db.prepare(`
    SELECT origin_message_id, origin_chat_id, note, created_at
    FROM message_traces
    WHERE user_id = ?
    ORDER BY created_at DESC, origin_message_id DESC
  `).all(userId);

  const items = rows.map((trace) => {
    const source = db.prepare(`
      SELECT m.id, m.chat_id, m.text, m.file_path, m.document_path, m.document_name,
             m.created_at, m.deleted, m.deleted_by, m.attachment_archived_at,
             COALESCE(u.display_name, u.username) AS author,
             COALESCE(du.display_name, du.username) AS deleted_by_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN users du ON du.id = m.deleted_by
      WHERE m.id = ?
    `).get(trace.origin_message_id);

    const base = {
      origin_message_id: trace.origin_message_id,
      origin_chat_id: trace.origin_chat_id,
      note: trace.note,
      created_at: trace.created_at,
      kind: kindOf(source),
    };

    if (!source || source.deleted) {
      return {
        ...base,
        kind: 'messages',
        state: 'cleaned',
        // Кто подчистил — только когда это действительно известно. Для
        // исчезнувшей строки неизвестно ничего, и придумывать нечего.
        deleted_by_name: source ? source.deleted_by_name : null,
      };
    }

    const hidden = db.prepare(
      'SELECT 1 FROM message_hidden WHERE message_id = ? AND user_id = ?'
    ).get(source.id, userId) !== undefined;
    if (hidden) return { ...base, state: 'hidden' };

    // Право проверяется СЕЙЧАС, а не в момент сохранения: вышел из группы —
    // перестал ходить в свой же след.
    if (!isParticipant(source.chat_id, userId)) return { ...base, state: 'forbidden' };

    const chat = chatMeta(source.chat_id, userId);
    return {
      ...base,
      state: 'ok',
      chat: { id: source.chat_id, name: chat.name, kind: chat.kind, avatar_path: chat.avatar_path },
      author: source.author,
      text: source.text || '',
      file_path: source.attachment_archived_at ? null : source.file_path,
      document_name: source.attachment_archived_at ? null : source.document_name,
      attachment_archived: !!source.attachment_archived_at,
      message_created_at: source.created_at,
    };
  });

  if (kind === 'all') return items;
  if (kind === 'notes') return items.filter((item) => !!item.note);
  return items.filter((item) => item.kind === kind);
}

module.exports = {
  MAX_NOTE_LENGTH,
  kindOf,
  listTraces,
  resolveOrigin,
  normalizeNote,
  setTrace,
  removeTrace,
  hasTrace,
  traceCount,
  countsForMessages,
  attachTraceCounts,
};
