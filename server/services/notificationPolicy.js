const db = require('../db');

class NotificationPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NotificationPolicyError';
    this.code = code;
  }
}

function isChatMuted(userId, chatId) {
  if (!userId || !chatId) return false;
  const row = db.prepare(`
    SELECT muted FROM chat_notification_settings
    WHERE user_id = ? AND chat_id = ?
  `).get(Number(userId), String(chatId));
  return !!row?.muted;
}

function canForceNotification(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(Number(userId));
  // Принудительный сигнал сильнее пользовательских настроек, поэтому это
  // отдельное право администратора, а не общее право модерации.
  return row?.role === 'admin';
}

function resolveForceNotification(userId, requested) {
  if (requested !== true) return false;
  if (!canForceNotification(userId)) {
    throw new NotificationPolicyError(
      'force_notification_forbidden',
      'Принудительное уведомление доступно только администратору'
    );
  }
  return true;
}

function shouldNotifyUser(userId, chatId, forceNotification = false) {
  return forceNotification === true || !isChatMuted(userId, chatId);
}

function setChatMuted(userId, chatId, muted) {
  const normalizedUserId = Number(userId);
  const normalizedChatId = String(chatId || '').trim();
  if (!Number.isInteger(normalizedUserId) || !normalizedChatId || normalizedChatId.length > 200) {
    throw new NotificationPolicyError('invalid_notification_target', 'Некорректный чат');
  }

  if (muted) {
    db.prepare(`
      INSERT INTO chat_notification_settings (user_id, chat_id, muted, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id, chat_id) DO UPDATE SET muted = 1, updated_at = excluded.updated_at
    `).run(normalizedUserId, normalizedChatId, Date.now());
  } else {
    db.prepare('DELETE FROM chat_notification_settings WHERE user_id = ? AND chat_id = ?')
      .run(normalizedUserId, normalizedChatId);
  }
  return { chat_id: normalizedChatId, muted: !!muted };
}

module.exports = {
  NotificationPolicyError,
  isChatMuted,
  canForceNotification,
  resolveForceNotification,
  shouldNotifyUser,
  setChatMuted,
};
