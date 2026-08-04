const db = require('../db');

// Личный чат — ровно один возможный получатель, поэтому общий messages.status
// однозначно значит "прочитано этим человеком". Общий чат и группы — получателей
// несколько, и там status нужен только для галочек у отправителя ("прочитано хоть
// кем-то"); кто именно прочитал конкретный человек, знает только message_reads.
const SHARED_CHAT_RE = /^(general|group_\d+)$/;
function isSharedChat(chatId) {
  return SHARED_CHAT_RE.test(String(chatId));
}

const insertRead = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)');

/**
 * Отмечает переданные id сообщений прочитанными для конкретного человека в
 * конкретном чате. Возвращает те id, что реально стали прочитанными только
 * что (не были прочитаны раньше) — их и нужно разослать дальше.
 */
function markRead(userId, chatId, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');

  if (isSharedChat(chatId)) {
    const candidates = db.prepare(`
      SELECT id FROM messages WHERE id IN (${placeholders}) AND chat_id = ? AND sender_id != ?
    `).all(...ids, chatId, userId).map((row) => row.id);
    if (!candidates.length) return [];

    const now = Date.now();
    const newlyRead = candidates.filter((id) => insertRead.run(id, userId, now).changes > 0);
    if (!newlyRead.length) return [];

    // Общий status двигаем следом, но только вперёд: он тут — просто отметка
    // "видел хоть один человек" для галочек у отправителя, а не источник
    // истины про конкретного читателя.
    const newPlaceholders = newlyRead.map(() => '?').join(',');
    db.prepare(`UPDATE messages SET status = 'read' WHERE id IN (${newPlaceholders}) AND status != 'read'`).run(...newlyRead);
    return newlyRead;
  }

  const affected = db.prepare(`
    SELECT id FROM messages WHERE id IN (${placeholders}) AND chat_id = ? AND sender_id != ? AND status != 'read'
  `).all(...ids, chatId, userId).map((row) => row.id);
  if (!affected.length) return [];

  // read_at — только здесь, в личной ветке: получатель ровно один, поэтому
  // «прочитано в» однозначно. В общих чатах эта же метка была бы враньём —
  // там время прочтения у каждого своё и лежит в message_reads.
  const affectedPlaceholders = affected.map(() => '?').join(',');
  db.prepare(`UPDATE messages SET status = 'read', read_at = ? WHERE id IN (${affectedPlaceholders})`)
    .run(Date.now(), ...affected);
  return affected;
}

/**
 * Сколько человек прочитало каждое из сообщений — для отметки «просмотрено» в
 * каналах-объявлениях. Возвращает { [messageId]: count }; PRIMARY KEY таблицы
 * начинается с message_id, так что COUNT идёт по индексу.
 */
function readCountsFor(ids) {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT message_id, COUNT(*) AS c FROM message_reads
    WHERE message_id IN (${placeholders})
    GROUP BY message_id
  `).all(...ids);

  // Сообщения, которых нет в message_reads, в выборку не попадут вовсе —
  // проставляем им ноль сами, иначе счётчик у них просто не обновится.
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const row of rows) counts[row.message_id] = row.c;
  return counts;
}

module.exports = { isSharedChat, markRead, readCountsFor };
