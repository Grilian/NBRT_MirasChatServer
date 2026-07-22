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

  const match = String(chatId).match(/^chat_(\d+)_(\d+)$/);
  if (match) return [Number(match[1]), Number(match[2])];

  return []; // неизвестный формат chat_id — на всякий случай никому
}

function isParticipant(chatId, userId) {
  const participants = participantsForChatId(chatId);
  if (participants === null) return true; // общий чат — виден всем
  return participants.includes(Number(userId));
}

module.exports = { parseAdminChatId, participantsForChatId, isParticipant };
