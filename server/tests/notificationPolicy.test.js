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
