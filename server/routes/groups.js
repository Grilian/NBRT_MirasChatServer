const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const {
  canPostToGroup, writeSettingsOf, saveWriteSettings, isWritePolicy,
} = require('../services/chatPermissions');

const router = express.Router();

const chatIdOf = (groupId) => `group_${groupId}`;

// Роли, которым можно писать в канал-объявление (announcements_only) —
// орг-роль из users.role, а не роль внутри самой группы: owner/member тут ни
// при чём, речь про "администрация организации", а не про того, кто завёл чат.
const ANNOUNCE_POST_ROLES = new Set(['admin', 'moderator']);

function canPostAnnouncement(userId) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return !!row && ANNOUNCE_POST_ROLES.has(row.role);
}

function memberRow(groupId, userId) {
  return db.prepare('SELECT role FROM chat_group_members WHERE chat_group_id = ? AND user_id = ?').get(groupId, userId);
}

function requireMember(req, res, next) {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Некорректный id группы' });
  const member = memberRow(groupId, req.userId);
  if (!member) return res.status(403).json({ error: 'Вы не участник этой группы' });
  req.groupId = groupId;
  req.groupRole = member.role;
  next();
}

function requireOwner(req, res, next) {
  if (req.groupRole !== 'owner') return res.status(403).json({ error: 'Действие доступно только создателю группы' });
  next();
}

function groupMembers(groupId) {
  return db.prepare(`
    SELECT u.id, u.display_name, u.username, u.avatar_path, m.role
    FROM chat_group_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.chat_group_id = ?
    ORDER BY (m.role = 'owner') DESC, u.display_name COLLATE NOCASE
  `).all(groupId);
}

// can_post зависит от конкретного зрителя, а group_updated шлётся одним и тем
// же объектом сразу всем участникам — поэтому его тут нет. Вместо него letят
// сама политика и списки, по которым клиент считает «могу ли я» для себя; в
// REST-выдачах ниже, где запрос персональный, can_post проставляется сервером.
function groupSummary(groupId) {
  const group = db.prepare('SELECT id, name, created_by, created_at, announcements_only FROM chat_groups WHERE id = ?').get(groupId);
  if (!group) return null;
  const members = groupMembers(groupId);
  return {
    id: group.id,
    chat_id: chatIdOf(group.id),
    name: group.name,
    created_by: group.created_by,
    created_at: group.created_at,
    member_count: members.length,
    members,
    announcements_only: !!group.announcements_only,
    ...writeSettingsOf(groupId),
  };
}

// Группы, где текущий человек состоит — попадают в список чатов наравне с
// личной перепиской.
router.get('/', verifyToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT g.id, g.name, g.created_by, g.created_at, g.announcements_only, m.role,
        (SELECT COUNT(*) FROM chat_group_members WHERE chat_group_id = g.id) AS member_count
      FROM chat_group_members m
      JOIN chat_groups g ON g.id = m.chat_group_id
      WHERE m.user_id = ?
      ORDER BY g.name COLLATE NOCASE
    `).all(req.userId);

    res.json(rows.map((row) => ({
      id: row.id,
      chat_id: chatIdOf(row.id),
      name: row.name,
      created_by: row.created_by,
      created_at: row.created_at,
      member_count: row.member_count,
      role: row.role,
      announcements_only: !!row.announcements_only,
      ...writeSettingsOf(row.id),
      // Запрос персональный — считаем право сразу здесь, чтобы клиенту не
      // приходилось повторять ту же логику и разойтись с сервером.
      can_post: canPostToGroup(row.id, req.userId),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создатель становится единственным 'owner'; себя в список участников
// добавлять не нужно — POST добавляет его автоматически. Канал-объявление
// может завести кто угодно (не только сам админ/модератор) — это его
// собственный чат, право писать в него определяется ролью на момент отправки,
// а не тем, кто его создал.
router.post('/', verifyToken, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Название группы обязательно' });
    const announcementsOnly = !!req.body.announcements_only;

    const memberIds = Array.isArray(req.body.member_ids)
      ? Array.from(new Set(req.body.member_ids.map(Number).filter((id) => Number.isInteger(id) && id !== req.userId)))
      : [];

    // Приглашённые должны реально существовать — иначе осиротевшая строка
    // участника ссылалась бы на несуществующего пользователя.
    const validIds = memberIds.filter((id) => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));

    const now = Date.now();
    const createGroup = db.transaction(() => {
      const groupId = db.prepare('INSERT INTO chat_groups (name, created_by, created_at, announcements_only) VALUES (?, ?, ?, ?)')
        .run(name, req.userId, now, announcementsOnly ? 1 : 0).lastInsertRowid;

      const addMember = db.prepare('INSERT INTO chat_group_members (chat_group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
      addMember.run(groupId, req.userId, 'owner', now);
      for (const id of validIds) addMember.run(groupId, id, 'member', now);

      return groupId;
    });

    const groupId = createGroup();
    const summary = groupSummary(groupId);

    const io = req.app.get('io');
    for (const id of validIds) io.to('user:' + id).emit('group_created', summary);

    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', verifyToken, requireMember, (req, res) => {
  try {
    res.json(groupSummary(req.groupId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// announcements_only — необязательное поле: если тело не содержит его вовсе
// (например, старый клиент шлёт только name), настройка не трогается —
// сохраняем текущее значение.
router.put('/:id', verifyToken, requireMember, requireOwner, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Название группы обязательно' });

    // Сначала валидируем всё тело. Раньше имя/режим объявлений успевали
    // сохраниться, а затем неверная write_policy возвращала 400 — клиент видел
    // ошибку, хотя половина запроса уже применялась.
    if (req.body.write_policy !== undefined && !isWritePolicy(req.body.write_policy)) {
      return res.status(400).json({ error: 'Неизвестная политика записи' });
    }

    const saveGroup = db.transaction(() => {
      if (req.body.announcements_only !== undefined) {
        db.prepare('UPDATE chat_groups SET name = ?, announcements_only = ? WHERE id = ?')
          .run(name, req.body.announcements_only ? 1 : 0, req.groupId);
      } else {
        db.prepare('UPDATE chat_groups SET name = ? WHERE id = ?').run(name, req.groupId);
      }

      // Политика — тоже необязательное поле: старый клиент, присылающий одно
      // название, не должен молча сбрасывать права на «всем можно».
      if (req.body.write_policy !== undefined) {
        saveWriteSettings(
          req.groupId,
          req.body.write_policy,
          Array.isArray(req.body.write_user_ids) ? req.body.write_user_ids.map(Number) : [],
          Array.isArray(req.body.write_department_ids) ? req.body.write_department_ids.map(Number) : [],
        );
      }
    });
    saveGroup();

    const summary = groupSummary(req.groupId);
    const io = req.app.get('io');
    for (const m of summary.members) io.to('user:' + m.id).emit('group_updated', summary);

    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удаляет группу целиком: участников (каскадом через FK) и всю переписку.
// Только владелец — потеря переписки для всех участников необратима.
router.delete('/:id', verifyToken, requireMember, requireOwner, (req, res) => {
  try {
    const chatId = chatIdOf(req.groupId);
    const memberIds = groupMembers(req.groupId).map((m) => m.id);

    const removeGroup = db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
      db.prepare('DELETE FROM favorites WHERE chat_id = ?').run(chatId);
      db.prepare('DELETE FROM chat_groups WHERE id = ?').run(req.groupId);
    });
    removeGroup();

    const io = req.app.get('io');
    for (const id of memberIds) io.to('user:' + id).emit('group_removed', { id: req.groupId, chat_id: chatId });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/members', verifyToken, requireMember, requireOwner, (req, res) => {
  try {
    const ids = Array.isArray(req.body.user_ids)
      ? Array.from(new Set(req.body.user_ids.map(Number).filter(Number.isInteger)))
      : [];
    const validIds = ids.filter((id) => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));

    const now = Date.now();
    const addMember = db.prepare('INSERT OR IGNORE INTO chat_group_members (chat_group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    const added = [];
    for (const id of validIds) {
      if (addMember.run(req.groupId, id, 'member', now).changes > 0) added.push(id);
    }

    const summary = groupSummary(req.groupId);
    const io = req.app.get('io');
    for (const m of summary.members) io.to('user:' + m.id).emit('group_updated', summary);
    for (const id of added) io.to('user:' + id).emit('group_created', summary);

    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Владелец может убрать любого; человек может выйти сам. Владелец выйти не
// может, не передав группу — с пустым набором прав это лишняя сложность,
// проще потребовать сначала удалить группу.
router.delete('/:id/members/:userId', verifyToken, requireMember, (req, res) => {
  try {
    const targetId = Number(req.params.userId);
    if (targetId !== req.userId && req.groupRole !== 'owner') {
      return res.status(403).json({ error: 'Убрать участника может только создатель группы' });
    }
    if (targetId === req.userId && req.groupRole === 'owner') {
      return res.status(400).json({ error: 'Создатель не может выйти из своей группы — удалите её целиком' });
    }

    db.prepare('DELETE FROM chat_group_members WHERE chat_group_id = ? AND user_id = ?').run(req.groupId, targetId);

    const io = req.app.get('io');
    const chatId = chatIdOf(req.groupId);
    io.to('user:' + targetId).emit('group_removed', { id: req.groupId, chat_id: chatId });

    const summary = groupSummary(req.groupId);
    if (summary) {
      for (const m of summary.members) io.to('user:' + m.id).emit('group_updated', summary);
      res.json(summary);
    } else {
      res.json({ removed: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Массовое удаление чужих сообщений в группе — владелец либо орг-администрация
// (те же права, что и у одиночного удаления «для всех», см. canDeleteForEveryone
// в index.js). Обычный участник свои сообщения удаляет сокетом по одному, а
// чужие может только скрыть у себя.
function requireGroupCleaner(req, res, next) {
  if (req.groupRole === 'owner' || canPostAnnouncement(req.userId)) return next();
  return res.status(403).json({ error: 'Удалять чужие сообщения может владелец группы или администрация' });
}

router.post('/:id/messages/delete', verifyToken, requireMember, requireGroupCleaner, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids)
      ? Array.from(new Set(req.body.ids.map(Number).filter(Number.isInteger)))
      : [];
    if (!ids.length) return res.status(400).json({ error: 'Не выбрано ни одного сообщения' });

    const chatId = chatIdOf(req.groupId);
    const placeholders = ids.map(() => '?').join(',');

    // Сужаем до сообщений именно этого чата — иначе id из чужой переписки,
    // подставленный в запрос, тоже бы отметился удалённым.
    const affectedRows = db.prepare(`SELECT id FROM messages WHERE id IN (${placeholders}) AND chat_id = ?`)
      .all(...ids, chatId);
    if (!affectedRows.length) return res.json({ deleted: [] });
    const affected = affectedRows.map((row) => row.id);

    // Только флаг — text/file_path и сам файл на диске не трогаем: по закону
    // нужно быть готовыми предоставить переписку целиком, удаление лишь
    // прячет сообщение из интерфейса (см. message_delete в index.js).
    const affectedPlaceholders = affected.map(() => '?').join(',');
    const now = Date.now();
    db.prepare(`
      UPDATE messages
      SET deleted = 1, deleted_at = ?, deleted_by = ?
      WHERE id IN (${affectedPlaceholders})
         OR thread_root_id IN (${affectedPlaceholders})
    `).run(now, req.userId, ...affected, ...affected);

    const io = req.app.get('io');
    const memberIds = groupMembers(req.groupId).map((m) => m.id);
    for (const id of memberIds) io.to('user:' + id).emit('messages_deleted', { chat_id: chatId, ids: affected });

    res.json({ deleted: affected });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.canPostAnnouncement = canPostAnnouncement;
