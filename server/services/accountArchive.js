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

  const archive = {
    archived_at: new Date().toISOString(),
    profile: (({ password, ...rest }) => rest)(user),
    messages,
    favorites: db.prepare('SELECT * FROM favorites WHERE user_id = ?').all(id),
    comments_made: db.prepare('SELECT * FROM user_comments WHERE user_id = ?').all(id),
    comments_received: db.prepare('SELECT * FROM user_comments WHERE target_user_id = ?').all(id),
    contacts_of: db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(id),
    contacted_by: db.prepare('SELECT * FROM contacts WHERE contact_user_id = ?').all(id),
  };

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const safeUsername = user.username.replace(/[^a-zA-Z0-9_-]/g, '_');
  const backupFile = `${safeUsername}_${id}_${Date.now()}.json`;
  fs.writeFileSync(path.join(BACKUPS_DIR, backupFile), JSON.stringify(archive, null, 2), 'utf8');

  const tx = db.transaction(() => {
    if (relatedChatIds.length) {
      db.prepare(`DELETE FROM messages WHERE chat_id IN (${relatedChatIds.map(() => '?').join(',')})`).run(...relatedChatIds);
    }
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
