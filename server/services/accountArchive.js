const fs = require('fs');
const path = require('path');
const db = require('../db');
const { deleteAvatarFile } = require('../utils/files');

const BACKUPS_DIR = path.join(__dirname, '..', 'backups', 'deleted_users');

// Треды "1 на 1" с этим пользователем целиком принадлежат ему (в отличие от
// "general", это общий канал на всех) — собираем их по chat_id, а не только
// по sender_id, иначе потеряли бы сообщения собеседника из архива и удаления.
function relatedChatIdsFor(id) {
  const idStr = String(id);
  return db.prepare('SELECT DISTINCT chat_id FROM messages')
    .all()
    .map(row => row.chat_id)
    .filter(chatId => {
      if (chatId.startsWith('miras_admin_')) return chatId.endsWith('_' + idStr);
      const match = chatId.match(/^chat_(\d+)_(\d+)$/);
      return !!match && (match[1] === idStr || match[2] === idStr);
    });
}

// Полное удаление аккаунта вместе с историей переписки. Перед стиранием из
// базы сохраняем всё, что о нём известно, в JSON на диске — на случай, если
// удаление окажется ошибкой или понадобится восстановить важную переписку.
// allowMirror снимает защиту от удаления служебных miras_-зеркал: обычный
// самостоятельный DELETE /me её сохраняет, а удаление из панели супер-админа —
// нет (нужно, чтобы можно было протестировать и подчистить эти зеркала).
function archiveAndDeleteUser(id, { allowMirror = false } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;

  if (!allowMirror && user.username.startsWith('miras_')) {
    throw new Error('Нельзя удалить служебную учётную запись');
  }

  const relatedChatIds = relatedChatIdsFor(id);

  const messages = relatedChatIds.length
    ? db.prepare(`
        SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id IN (${relatedChatIds.map(() => '?').join(',')})
        ORDER BY m.created_at
      `).all(...relatedChatIds)
    : [];

  // Опросы — часть содержимого сообщений, но лежат в отдельных таблицах.
  // Собираем как созданные пользователем, так и привязанные к сообщениям,
  // которые будут физически удалены вместе с аккаунтом/личным тредом.
  const pollRows = [
    ...db.prepare('SELECT * FROM polls WHERE creator_id = ? OR message_id IN (SELECT id FROM messages WHERE sender_id = ?)').all(id, id),
    ...(relatedChatIds.length
      ? db.prepare(`SELECT * FROM polls WHERE chat_id IN (${relatedChatIds.map(() => '?').join(',')})`).all(...relatedChatIds)
      : []),
  ];
  const polls = Array.from(new Map(pollRows.map((poll) => [poll.id, poll])).values());
  const pollIds = polls.map((poll) => poll.id);
  const pollOptions = pollIds.length
    ? db.prepare(`SELECT * FROM poll_options WHERE poll_id IN (${pollIds.map(() => '?').join(',')})`).all(...pollIds)
    : [];
  const pollVotes = pollIds.length
    ? db.prepare(`SELECT * FROM poll_votes WHERE poll_id IN (${pollIds.map(() => '?').join(',')})`).all(...pollIds)
    : [];

  const archive = {
    archived_at: new Date().toISOString(),
    profile: (({ password, ...rest }) => rest)(user),
    messages,
    polls,
    poll_options: pollOptions,
    poll_votes: pollVotes,
    favorites: db.prepare('SELECT * FROM favorites WHERE user_id = ?').all(id),
    comments_made: db.prepare('SELECT * FROM user_comments WHERE user_id = ?').all(id),
    comments_received: db.prepare('SELECT * FROM user_comments WHERE target_user_id = ?').all(id),
    contacts_of: db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(id),
    contacted_by: db.prepare('SELECT * FROM contacts WHERE contact_user_id = ?').all(id),
    device_tokens: db.prepare('SELECT * FROM device_tokens WHERE user_id = ?').all(id),
    app_versions: db.prepare('SELECT * FROM user_app_versions WHERE user_id = ?').all(id),
    calendar_events: db.prepare('SELECT * FROM calendar_events WHERE owner_id = ?').all(id),
    calendar_invitations: db.prepare('SELECT * FROM calendar_event_guests WHERE user_id = ?').all(id),
    tasks_created: db.prepare('SELECT * FROM tasks WHERE created_by = ?').all(id),
    task_participation: db.prepare('SELECT * FROM task_participants WHERE user_id = ?').all(id),
    chat_groups_owned: db.prepare('SELECT * FROM chat_groups WHERE created_by = ?').all(id),
    chat_group_membership: db.prepare('SELECT * FROM chat_group_members WHERE user_id = ?').all(id),
    message_reads: db.prepare('SELECT * FROM message_reads WHERE user_id = ?').all(id),
    message_hidden: db.prepare('SELECT * FROM message_hidden WHERE user_id = ?').all(id),
    message_reactions: db.prepare('SELECT * FROM message_reactions WHERE user_id = ?').all(id),
    poll_options_created: db.prepare('SELECT * FROM poll_options WHERE created_by = ?').all(id),
    poll_votes_cast: db.prepare('SELECT * FROM poll_votes WHERE user_id = ?').all(id),
  };

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const safeUsername = user.username.replace(/[^a-zA-Z0-9_-]/g, '_');
  const backupFile = `${safeUsername}_${id}_${Date.now()}.json`;
  fs.writeFileSync(path.join(BACKUPS_DIR, backupFile), JSON.stringify(archive, null, 2), 'utf8');

  const tx = db.transaction(() => {
    // Сначала персональные голоса в чужих опросах, затем целиком собственные
    // опросы. Внешние ключи на продовой БД могут быть выключены, поэтому на
    // каскад не полагаемся.
    db.prepare('DELETE FROM poll_votes WHERE user_id = ?').run(id);
    // Вариант, добавленный участником в чужой опрос, тоже ссылается на него.
    // Голоса за этот вариант уйдут каскадом вместе с ним.
    db.prepare('DELETE FROM poll_options WHERE created_by = ?').run(id);
    if (pollIds.length) {
      const placeholders = pollIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM poll_votes WHERE poll_id IN (${placeholders})`).run(...pollIds);
      db.prepare(`DELETE FROM poll_options WHERE poll_id IN (${placeholders})`).run(...pollIds);
      db.prepare(`DELETE FROM polls WHERE id IN (${placeholders})`).run(...pollIds);
    }
    if (relatedChatIds.length) {
      db.prepare(`DELETE FROM messages WHERE chat_id IN (${relatedChatIds.map(() => '?').join(',')})`).run(...relatedChatIds);
    }

    // В группах с другими участниками передаём владение следующему участнику,
    // чтобы удаление аккаунта не уничтожало общий чат. Пустую группу удаляем.
    const ownedGroups = db.prepare('SELECT id FROM chat_groups WHERE created_by = ?').all(id);
    for (const group of ownedGroups) {
      const replacement = db.prepare(`
        SELECT user_id FROM chat_group_members
        WHERE chat_group_id = ? AND user_id != ?
        ORDER BY joined_at, id LIMIT 1
      `).get(group.id, id);
      if (replacement) {
        db.prepare('UPDATE chat_groups SET created_by = ? WHERE id = ?').run(replacement.user_id, group.id);
        db.prepare("UPDATE chat_group_members SET role = 'owner' WHERE chat_group_id = ? AND user_id = ?")
          .run(group.id, replacement.user_id);
      } else {
        const chatId = `group_${group.id}`;
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM favorites WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chat_groups WHERE id = ?').run(group.id);
      }
    }

    db.prepare('DELETE FROM calendar_event_guests WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM calendar_events WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM task_participants WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE created_by = ?').run(id);
    db.prepare('DELETE FROM message_reads WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM message_hidden WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM message_reactions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM chat_group_writers WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM chat_group_members WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM device_tokens WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_app_versions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(id);
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_comments WHERE user_id = ? OR target_user_id = ?').run(id, id);
    db.prepare('DELETE FROM contacts WHERE user_id = ? OR contact_user_id = ?').run(id, id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  tx();
  deleteAvatarFile(user.avatar_path);

  return { user, backupFile };
}

module.exports = { archiveAndDeleteUser };
