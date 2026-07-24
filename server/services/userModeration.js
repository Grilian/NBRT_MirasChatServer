const db = require('../db');
const { isValidAccountType } = require('../utils/validators');

const VALID_ROLES = ['user', 'moderator', 'admin'];

// Общая логика правки "модерируемых" полей пользователя — используется и
// панелью супер-админа, и встроенным админ-управлением в профиле (для тех,
// у кого роль "Администратор"), чтобы правила не разъезжались между ними.
function applyModeration(targetId, patch) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!user) return null;

  const updates = [];
  const params = [];

  if (patch.group_id !== undefined) {
    const groupId = patch.group_id === null ? null : Number(patch.group_id);
    if (groupId !== null) {
      const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
      if (!group) throw new Error('Группа не найдена');
    }
    updates.push('group_id = ?');
    params.push(groupId);
  }

  if (patch.role !== undefined) {
    const role = patch.role ? String(patch.role) : null;
    if (role !== null && !VALID_ROLES.includes(role)) throw new Error('Некорректная роль');
    updates.push('role = ?');
    params.push(role);
  }

  if (patch.account_type !== undefined) {
    const accountType = String(patch.account_type);
    if (!isValidAccountType(accountType)) throw new Error('Некорректный тип аккаунта');
    updates.push('account_type = ?');
    params.push(accountType);
  }

  if (patch.muted !== undefined) {
    updates.push('muted = ?');
    params.push(patch.muted ? 1 : 0);
  }

  if (updates.length > 0) {
    params.push(targetId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.group_id, u.role, u.muted, u.account_type, g.name AS group_name
    FROM users u
    LEFT JOIN groups g ON g.id = u.group_id
    WHERE u.id = ?
  `).get(targetId);
}

// Живое уведомление затронутому пользователю — тишина/роль/группа/тип должны
// подействовать сразу, не дожидаясь перелогина.
function notifyModerated(io, updated) {
  if (!io) return;
  io.to('user:' + updated.id).emit('account_updated', {
    muted: !!updated.muted,
    role: updated.role,
    group_id: updated.group_id,
    account_type: updated.account_type,
  });
}

module.exports = { applyModeration, notifyModerated, VALID_ROLES };
