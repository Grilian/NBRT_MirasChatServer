const db = require('../db');

// Единый механизм «Кто может писать» для групповых чатов. Один источник правды
// на всё приложение: и сокет-обработчик chat_message, и REST спрашивают
// именно отсюда, чтобы право не разошлось между «сервер пустил» и «клиент
// показал композер».
//
// Право писать НЕ зависит от роли внутри группы (owner/member) и не даётся
// никому неявно. «Только администратор» — отдельный вариант политики, значит
// в остальных режимах администрация организации права молча не получает, а
// владельцу, которому нужно писать, следует добавить себя в список. Так
// настройка означает ровно то, что в ней написано.

const WRITE_POLICIES = ['all', 'members', 'departments', 'admins', 'nobody'];

// Орг-роль из users.role — это «администрация организации», а не тот, кто
// завёл чат.
const ADMIN_ROLES = new Set(['admin', 'moderator']);

const isWritePolicy = (value) => WRITE_POLICIES.includes(value);

function writersOf(groupId) {
  return db.prepare('SELECT user_id FROM chat_group_writers WHERE group_id = ?')
    .all(groupId).map((r) => r.user_id);
}

function writerDepartmentsOf(groupId) {
  return db.prepare('SELECT department_id FROM chat_group_writer_departments WHERE group_id = ?')
    .all(groupId).map((r) => r.department_id);
}

/**
 * Может ли человек отправить сообщение в группу. Участие в группе тут НЕ
 * проверяется — это отдельное условие, его проверяет вызывающий код
 * (isParticipant в index.js), иначе одна ошибка в политике открыла бы чат
 * посторонним.
 */
function canPostToGroup(groupId, userId) {
  const group = db.prepare('SELECT write_policy FROM chat_groups WHERE id = ?').get(groupId);
  if (!group) return false;

  // Неизвестное значение трактуем как самое строгое, а не как «всем можно»:
  // испорченная строка в базе не должна открывать доступ.
  const policy = isWritePolicy(group.write_policy) ? group.write_policy : 'nobody';

  switch (policy) {
    case 'all':
      return true;
    case 'nobody':
      return false;
    case 'admins': {
      const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
      return !!row && ADMIN_ROLES.has(row.role);
    }
    case 'members': {
      const row = db.prepare('SELECT 1 AS ok FROM chat_group_writers WHERE group_id = ? AND user_id = ?')
        .get(groupId, userId);
      return !!row;
    }
    case 'departments': {
      // Отдел человека может быть не задан вовсе — тогда ни в один список он
      // не попадает, и это правильный ответ, а не повод пустить.
      const row = db.prepare(`
        SELECT 1 AS ok FROM users u
        JOIN chat_group_writer_departments d ON d.department_id = u.department_id
        WHERE u.id = ? AND d.group_id = ? AND u.department_id IS NOT NULL
      `).get(userId, groupId);
      return !!row;
    }
    default:
      return false;
  }
}

/** Политика группы вместе со списками — для настроек и для клиента. */
function writeSettingsOf(groupId) {
  const group = db.prepare('SELECT write_policy FROM chat_groups WHERE id = ?').get(groupId);
  const policy = group && isWritePolicy(group.write_policy) ? group.write_policy : 'all';
  return {
    write_policy: policy,
    write_user_ids: policy === 'members' ? writersOf(groupId) : [],
    write_department_ids: policy === 'departments' ? writerDepartmentsOf(groupId) : [],
  };
}

/**
 * Сохранение политики. Списки переписываются целиком и только для той
 * политики, которой они принадлежат: иначе смена режима туда-обратно
 * оставляла бы за собой список, о котором в интерфейсе уже ничего не сказано.
 */
const saveWriteSettings = db.transaction((groupId, policy, userIds, departmentIds) => {
  db.prepare('UPDATE chat_groups SET write_policy = ? WHERE id = ?').run(policy, groupId);

  db.prepare('DELETE FROM chat_group_writers WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM chat_group_writer_departments WHERE group_id = ?').run(groupId);

  if (policy === 'members') {
    const insert = db.prepare('INSERT OR IGNORE INTO chat_group_writers (group_id, user_id) VALUES (?, ?)');
    // Писать может только тот, кто состоит в группе: список пишущих не должен
    // быть способом протащить в чат постороннего.
    const isMember = db.prepare('SELECT 1 AS ok FROM chat_group_members WHERE chat_group_id = ? AND user_id = ?');
    for (const id of userIds) {
      if (Number.isInteger(id) && isMember.get(groupId, id)) insert.run(groupId, id);
    }
  }

  if (policy === 'departments') {
    const insert = db.prepare('INSERT OR IGNORE INTO chat_group_writer_departments (group_id, department_id) VALUES (?, ?)');
    const exists = db.prepare('SELECT 1 AS ok FROM departments WHERE id = ?');
    for (const id of departmentIds) {
      if (Number.isInteger(id) && exists.get(id)) insert.run(groupId, id);
    }
  }
});

module.exports = {
  WRITE_POLICIES, canPostToGroup, writeSettingsOf, saveWriteSettings, isWritePolicy,
};
