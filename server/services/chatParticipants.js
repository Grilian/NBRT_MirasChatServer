const db = require('../db');

// chat_id для переписки с админом имеет вид miras_admin_<login>_<localUserId>,
// чтобы у каждого сотрудника был свой отдельный тред с админом, а не один
// общий на всех, кто ему когда-либо писал.
function parseAdminChatId(chatId) {
  const prefix = 'miras_admin_';
  if (!chatId || !chatId.startsWith(prefix)) return null;

  const rest = chatId.slice(prefix.length);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore === -1) return null;

  return {
    login: rest.slice(0, lastUnderscore),
    employeeId: rest.slice(lastUnderscore + 1)
  };
}

// Личные чаты (1:1 между сотрудниками и переписка с админом) должны быть видны
// только реальным участникам треда. null означает общий чат — его видят все.
function participantsForChatId(chatId) {
  if (chatId === 'general') return null;
  if (!chatId) return [];

  const adminChat = parseAdminChatId(chatId);
  if (adminChat) return [Number(adminChat.employeeId)];

  // Групповой чат — состав читаем из БД на каждый вызов, а не кэшируем:
  // список участников меняется (добавили/убрали), и устаревший кэш пустил бы
  // сообщение мимо нового участника или, наоборот, к уже удалённому.
  const groupMatch = String(chatId).match(/^group_(\d+)$/);
  if (groupMatch) {
    const rows = db.prepare('SELECT user_id FROM chat_group_members WHERE chat_group_id = ?').all(Number(groupMatch[1]));
    return rows.map((row) => row.user_id);
  }

  // Личный чат «для себя» (заметки, пересылки). Участник ровно один — сам
  // владелец: id зашит в chat_id, поэтому отдельной таблицы не нужно, а
  // проверка участия сводится к сравнению с ним.
  const selfMatch = String(chatId).match(/^self_(\d+)$/);
  if (selfMatch) return [Number(selfMatch[1])];

  const match = String(chatId).match(/^chat_(\d+)_(\d+)$/);
  if (match) return [Number(match[1]), Number(match[2])];

  return []; // неизвестный формат chat_id — на всякий случай никому
}

function isParticipant(chatId, userId) {
  const participants = participantsForChatId(chatId);
  if (participants === null) return true; // общий чат — виден всем
  return participants.includes(Number(userId));
}

/** chat_id личного чата «для себя» — по нему же его узнаёт participantsForChatId. */
function selfChatId(userId) {
  return `self_${Number(userId)}`;
}

module.exports = { parseAdminChatId, participantsForChatId, isParticipant, selfChatId };
