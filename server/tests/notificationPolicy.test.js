const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `miras-notification-policy-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_DB_PATH = dbPath;
process.env.SUPERADMIN_USERNAME = `notification_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'notification-test-password';

const db = require('../db');
const {
  NotificationPolicyError,
  canForceNotification,
  resolveForceNotification,
  setChatMuted,
  shouldNotifyUser,
} = require('../services/notificationPolicy');

function createUser(username, role = 'user') {
  return Number(db.prepare(
    'INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)'
  ).run(username, 'x', username, role).lastInsertRowid);
}

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('chat mute suppresses ordinary notifications but forced notification bypasses it', () => {
  const recipientId = createUser('notification_recipient');
  setChatMuted(recipientId, 'group_42', true);

  assert.equal(shouldNotifyUser(recipientId, 'group_42', false), false);
  assert.equal(shouldNotifyUser(recipientId, 'group_42', true), true);
  assert.equal(shouldNotifyUser(recipientId, 'chat_1_2', false), true);

  setChatMuted(recipientId, 'group_42', false);
  assert.equal(shouldNotifyUser(recipientId, 'group_42', false), true);
});

test('only an administrator can request a forced notification', () => {
  const userId = createUser('notification_user');
  const moderatorId = createUser('notification_moderator', 'moderator');
  const adminId = createUser('notification_role_admin', 'admin');

  assert.equal(canForceNotification(userId), false);
  assert.equal(canForceNotification(moderatorId), false);
  assert.equal(canForceNotification(adminId), true);
  assert.equal(resolveForceNotification(adminId, true), true);
  assert.equal(resolveForceNotification(userId, false), false);
  assert.throws(
    () => resolveForceNotification(userId, true),
    (error) => error instanceof NotificationPolicyError
      && error.code === 'force_notification_forbidden'
  );
});

// Общий чат — такой же chat_id, как любой другой, и правило глушения обязано
// работать для него ровно так же. Проверяем отдельно: переключатель в карточке
// общего чата есть, но его сквозной путь (панель → REST → эта проверка перед
// отправкой пуша) до сих пор ничем не был закреплён.
test('muting the general chat suppresses its notifications', () => {
  const recipientId = createUser('notification_general_recipient');

  assert.equal(shouldNotifyUser(recipientId, 'general', false), true);

  setChatMuted(recipientId, 'general', true);
  assert.equal(shouldNotifyUser(recipientId, 'general', false), false);
  // Глушение общего чата не должно задевать личную переписку.
  assert.equal(shouldNotifyUser(recipientId, 'chat_1_2', false), true);
  // Принудительное уведомление админа сильнее глушения — здесь тоже.
  assert.equal(shouldNotifyUser(recipientId, 'general', true), true);

  setChatMuted(recipientId, 'general', false);
  assert.equal(shouldNotifyUser(recipientId, 'general', false), true);
});
