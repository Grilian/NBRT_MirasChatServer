const db = require('../db');
const { readCountsFor } = require('../services/readReceipts');
const { canPostAnnouncement } = require('../routes/groups');

// Мелкие правила, общие для нескольких обработчиков сокета.
// Группы, кому можно писать даже в режиме тишины — обращение к администрации
// напрямую, а не рассылка (general всё равно остаётся заблокирован).
const MUTE_EXEMPT_GROUPS = ['Администрация', 'Админы'];

const MAX_MESSAGE_LENGTH = 4000;
const MAX_READ_BATCH = 500;

// engine.io не разбирает X-Forwarded-For сам (socket.handshake.address —
// это адрес nginx на локалхосте, а не клиента) — достаём реальный IP из
// заголовка, который nginx уже прокидывает (см. proxy_set_header
// X-Forwarded-For в конфиге). Он нужен только как метаданные о факте
// передачи сообщения, в интерфейс не попадает.
// Канал-объявление: в нём у каждого сообщения показывается «просмотрено» с
// числом прочитавших, и это число должно расти живьём, а не только после
// перезагрузки истории (её отдаёт routes/messages.js).
function isAnnouncementChat(chatId) {
  const match = String(chatId).match(/^group_(\d+)$/);
  if (!match) return false;
  const group = db.prepare('SELECT announcements_only FROM chat_groups WHERE id = ?').get(Number(match[1]));
  return !!(group && group.announcements_only);
}

// Довесок к message_status_bulk — только для каналов-объявлений, в обычной
// переписке счётчик не показывается и считать его незачем.
function readCountsPayload(chatId, ids) {
  return isAnnouncementChat(chatId) ? { readCounts: readCountsFor(ids) } : {};
}

// Цитата исходного сообщения для ответа — та же форма, что отдаёт история
// (см. routes/messages.js). Удалённое цитируем пустым текстом: строка в базе
// остаётся навсегда, но её содержимое наружу не отдаётся ни при каких
// обстоятельствах, включая цитаты.
function replyPreviewOf(replyToId) {
  const row = db.prepare(`
    SELECT m.text, m.file_path, m.sticker_fallback, m.document_name, m.attachment_archived_at, m.deleted,
           u.username, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(replyToId);
  if (!row) return {};
  return {
    reply_to_text: row.deleted ? '' : row.text,
    reply_to_file: (row.deleted || row.attachment_archived_at) ? null : row.file_path,
    reply_to_sticker_fallback: row.deleted ? null : row.sticker_fallback,
    reply_to_document_name: (row.deleted || row.attachment_archived_at) ? null : row.document_name,
    reply_to_author: row.display_name || row.username,
    reply_to_deleted: row.deleted ? 1 : 0,
  };
}

// Кто может убрать сообщение у ВСЕХ. Своё — всегда. Чужое: в личной переписке
// любой из двоих (собеседник ровно один, право симметрично), в общем чате и
// группах — владелец группы либо орг-администрация. Обычному участнику группы
// чужое доступно только «скрыть у себя»: иначе один человек мог бы вычистить
// переписку у полусотни людей, и восстановить её смог бы только админ
// запросом к базе (содержимое-то остаётся, но из интерфейса пропадает).
function canDeleteForEveryone(message, userId) {
  if (Number(message.sender_id) === Number(userId)) return true;

  const groupMatch = String(message.chat_id).match(/^group_(\d+)$/);
  if (groupMatch) {
    const membership = db.prepare(
      'SELECT role FROM chat_group_members WHERE chat_group_id = ? AND user_id = ?'
    ).get(Number(groupMatch[1]), userId);
    if (membership && membership.role === 'owner') return true;
    return canPostAnnouncement(userId); // admin/moderator по users.role
  }

  if (message.chat_id === 'general') return canPostAnnouncement(userId);

  // Личная переписка: участие уже проверено вызывающим кодом.
  return true;
}

function clientIpOf(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || null;
}

// Простейшая защита от флуда: не больше FLOOD_MAX_MESSAGES сообщений за
// FLOOD_WINDOW_MS с одного сокета. Без неё зациклившийся клиент (или кто-то
// вручную) мог за секунды забить БД и завалить уведомлениями всех участников.
const FLOOD_WINDOW_MS = 10000;
const FLOOD_MAX_MESSAGES = 20;

function isFlooding(socket) {
  const now = Date.now();
  const recent = (socket.recentMessageTimes || []).filter((t) => now - t < FLOOD_WINDOW_MS);
  recent.push(now);
  socket.recentMessageTimes = recent;
  return recent.length > FLOOD_MAX_MESSAGES;
}

module.exports = {
  MUTE_EXEMPT_GROUPS,
  MAX_MESSAGE_LENGTH,
  MAX_READ_BATCH,
  isAnnouncementChat,
  readCountsPayload,
  replyPreviewOf,
  canDeleteForEveryone,
  clientIpOf,
  isFlooding,
};
