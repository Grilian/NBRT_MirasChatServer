const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const dbPath = path.join(os.tmpdir(), `miras-regressions-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'regression-test-secret';
process.env.SUPERADMIN_USERNAME = `test_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'regression-test-password';

const db = require('../db');
const authRoutes = require('../routes/auth');
const messageRoutes = require('../routes/messages');
const calendarRoutes = require('../routes/calendar');
const groupRoutes = require('../routes/groups');
const taskRoutes = require('../routes/tasks');
const superadminRoutes = require('../routes/superadmin');
const unreadRoutes = require('../routes/unread');
const notificationSettingsRoutes = require('../routes/notificationSettings');
const { isValidBirthDate } = require('../utils/validators');
const { archiveAndDeleteUser } = require('../services/accountArchive');

const emitted = [];
const io = {
  to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/unread', unreadRoutes);
app.use('/api/notification-settings', notificationSettingsRoutes);

let server;
let baseUrl;

function createUser(username, role = null) {
  const password = bcrypt.hashSync('valid-password', 4);
  const result = db.prepare(
    'INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)'
  ).run(username, password, username, role);
  return Number(result.lastInsertRowid);
}

function tokenFor(id) {
  return jwt.sign({ id, username: `user_${id}`, source: 'local' }, process.env.JWT_SECRET);
}

async function request(route, { token, method = 'GET', body, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

test('legacy clients do not receive unread counts for thread-only replies', async () => {
  const authorId = createUser('unread_thread_author');
  const recipientId = createUser('unread_thread_recipient');
  const chatId = `chat_${Math.min(authorId, recipientId)}_${Math.max(authorId, recipientId)}`;
  const rootId = Number(db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)'
  ).run(chatId, authorId, 'root').lastInsertRowid);
  db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, thread_root_id) VALUES (?, ?, ?, ?)'
  ).run(chatId, authorId, 'thread reply', rootId);

  const token = tokenFor(recipientId);
  const legacy = await request('/api/unread', { token });
  const modern = await request('/api/unread', {
    token,
    headers: { 'X-Miras-Features': 'threads,notification-policy' },
  });

  assert.equal(legacy.response.status, 200);
  assert.equal(modern.response.status, 200);
  assert.equal(legacy.data[chatId], 1);
  assert.equal(modern.data[chatId], 2);
});

test('notification settings can mute only a chat available to the current user', async () => {
  const firstId = createUser('notification_settings_first');
  const secondId = createUser('notification_settings_second');
  const outsiderId = createUser('notification_settings_outsider');
  const chatId = `chat_${Math.min(firstId, secondId)}_${Math.max(firstId, secondId)}`;
  const token = tokenFor(firstId);

  const muted = await request(`/api/notification-settings/${chatId}`, {
    token,
    method: 'PUT',
    body: { muted: true },
  });
  assert.equal(muted.response.status, 200);
  assert.equal(muted.data.muted, true);

  const listed = await request('/api/notification-settings', { token });
  assert.deepEqual(listed.data.muted_chat_ids, [chatId]);

  const forbiddenChat = `chat_${Math.min(secondId, outsiderId)}_${Math.max(secondId, outsiderId)}`;
  const forbidden = await request(`/api/notification-settings/${forbiddenChat}`, {
    token,
    method: 'PUT',
    body: { muted: true },
  });
  assert.equal(forbidden.response.status, 403);
});

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('birth date validation rejects normalized impossible dates', () => {
  assert.equal(isValidBirthDate('2024-02-29'), true);
  assert.equal(isValidBirthDate('2025-02-29'), false);
  assert.equal(isValidBirthDate('2025-02-31'), false);
});

test('local login follows case-insensitive username uniqueness', async () => {
  createUser('CaseSensitiveUser');
  const { response, data } = await request('/api/auth/login', {
    method: 'POST', body: { username: 'casesensitiveuser', password: 'valid-password' },
  });
  assert.equal(response.status, 200);
  assert.equal(data.username, 'CaseSensitiveUser');
});

test('negative history limit cannot disable pagination', async () => {
  const userId = createUser('history_user');
  const insert = db.prepare("INSERT INTO messages (chat_id, sender_id, text) VALUES ('general', ?, ?)");
  for (let index = 0; index < 60; index += 1) insert.run(userId, `message ${index}`);

  const { response, data } = await request('/api/messages/general?limit=-1', { token: tokenFor(userId) });
  assert.equal(response.status, 200);
  assert.equal(data.messages.length, 50);
  assert.equal(data.hasMore, true);
});

test('editing an event persists its target calendar scope', async () => {
  const adminId = createUser('calendar_admin', 'admin');
  const token = tokenFor(adminId);
  const now = Date.now();
  const created = await request('/api/calendar/events', {
    token,
    method: 'POST',
    body: { title: 'Personal', starts_at: now, ends_at: now + 60_000, scope_kind: 'personal' },
  });
  assert.equal(created.response.status, 201);

  const updated = await request(`/api/calendar/events/${created.data.id}`, {
    token,
    method: 'PUT',
    body: { title: 'Global', starts_at: now, ends_at: now + 60_000, scope_kind: 'global' },
  });
  assert.equal(updated.response.status, 200);
  const row = db.prepare('SELECT scope_kind, scope_id FROM calendar_events WHERE id = ?').get(created.data.id);
  assert.deepEqual(row, { scope_kind: 'global', scope_id: null });
});

test('invalid group policy does not partially save other fields', async () => {
  const ownerId = createUser('group_owner');
  const token = tokenFor(ownerId);
  const created = await request('/api/groups', {
    token, method: 'POST', body: { name: 'Original', announcements_only: false },
  });
  assert.equal(created.response.status, 200);

  const updated = await request(`/api/groups/${created.data.id}`, {
    token,
    method: 'PUT',
    body: { name: 'Changed', announcements_only: true, write_policy: 'invalid' },
  });
  assert.equal(updated.response.status, 400);
  const row = db.prepare('SELECT name, announcements_only FROM chat_groups WHERE id = ?').get(created.data.id);
  assert.deepEqual(row, { name: 'Original', announcements_only: 0 });
});

test('invalid moderation patch does not partially rename a user', async () => {
  const userId = createUser('moderated_user');
  const superToken = jwt.sign(
    { id: 1, role: 'superadmin', username: 'test_admin' },
    process.env.JWT_SECRET,
  );
  const updated = await request(`/api/superadmin/users/${userId}`, {
    token: superToken,
    method: 'PUT',
    body: { username: 'renamed_user', role: 'invalid-role' },
  });
  assert.equal(updated.response.status, 400);
  assert.deepEqual(
    db.prepare('SELECT username FROM users WHERE id = ?').get(userId),
    { username: 'moderated_user' },
  );
});

test('successful superadmin logins do not consume the failure limit', async () => {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const result = await request('/api/superadmin/login', {
      method: 'POST',
      body: { username: process.env.SUPERADMIN_USERNAME, password: process.env.SUPERADMIN_PASSWORD },
    });
    assert.equal(result.response.status, 200);
  }
});

test('removed task participants receive a refresh event', async () => {
  const ownerId = createUser('task_owner');
  const participantId = createUser('task_participant');
  const token = tokenFor(ownerId);
  const created = await request('/api/tasks', {
    token,
    method: 'POST',
    body: { title: 'Shared task', participant_ids: [participantId] },
  });
  assert.equal(created.response.status, 201);
  emitted.length = 0;

  const updated = await request(`/api/tasks/${created.data.id}`, {
    token,
    method: 'PUT',
    body: { title: 'Private task', participant_ids: [] },
  });
  assert.equal(updated.response.status, 200);
  assert.ok(emitted.some((item) => item.room === `user:${participantId}` && item.event === 'tasks_changed'));
});

test('client message ids are idempotent per sender', () => {
  const senderId = createUser('queue_sender');
  const otherSenderId = createUser('queue_other_sender');
  const insert = db.prepare(`
    INSERT INTO messages (chat_id, sender_id, text, client_message_id)
    VALUES ('general', ?, 'queued', ?)
  `);

  insert.run(senderId, 'msg_queue_test_123456');
  assert.throws(
    () => insert.run(senderId, 'msg_queue_test_123456'),
    /UNIQUE constraint failed/,
  );
  assert.doesNotThrow(() => insert.run(otherSenderId, 'msg_queue_test_123456'));
});

test('account deletion clears dependent records and transfers group ownership', () => {
  const deletedId = createUser('deleted_user');
  const survivorId = createUser('surviving_user');
  const now = Date.now();

  db.prepare('INSERT INTO device_tokens (user_id, token, platform, updated_at) VALUES (?, ?, ?, ?)')
    .run(deletedId, 'device-token', 'android', now);
  db.prepare('INSERT INTO user_app_versions (user_id, platform, version, updated_at) VALUES (?, ?, ?, ?)')
    .run(deletedId, 'android', '1.0.0', now);
  const eventId = db.prepare(`
    INSERT INTO calendar_events
      (owner_id, title, starts_at, ends_at, created_at, updated_at)
    VALUES (?, 'Event', ?, ?, ?, ?)
  `).run(deletedId, now, now + 1000, now, now).lastInsertRowid;
  db.prepare('INSERT INTO calendar_event_guests (event_id, user_id) VALUES (?, ?)').run(eventId, survivorId);
  const taskId = db.prepare(`
    INSERT INTO tasks (title, created_by, created_at, updated_at) VALUES ('Task', ?, ?, ?)
  `).run(deletedId, now, now).lastInsertRowid;
  db.prepare('INSERT INTO task_participants (task_id, user_id) VALUES (?, ?)').run(taskId, survivorId);

  const groupId = db.prepare(`
    INSERT INTO chat_groups (name, created_by, created_at) VALUES ('Owned group', ?, ?)
  `).run(deletedId, now).lastInsertRowid;
  const addMember = db.prepare(`
    INSERT INTO chat_group_members (chat_group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
  `);
  addMember.run(groupId, deletedId, 'owner', now);
  addMember.run(groupId, survivorId, 'member', now + 1);

  const generalMessageId = db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text) VALUES ('general', ?, 'hello')"
  ).run(survivorId).lastInsertRowid;
  db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
    .run(generalMessageId, deletedId, '👍', now);

  const result = archiveAndDeleteUser(deletedId);
  assert.ok(result);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(deletedId), undefined);
  assert.deepEqual(
    db.prepare('SELECT created_by FROM chat_groups WHERE id = ?').get(groupId),
    { created_by: survivorId },
  );
  assert.deepEqual(
    db.prepare('SELECT role FROM chat_group_members WHERE chat_group_id = ? AND user_id = ?').get(groupId, survivorId),
    { role: 'owner' },
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const backupPath = path.join(__dirname, '..', 'backups', 'deleted_users', result.backupFile);
  fs.rmSync(backupPath, { force: true });
});
