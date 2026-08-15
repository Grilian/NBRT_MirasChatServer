const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

// Разделение типов аккаунтов и очистка переписки.

const dbPath = path.join(os.tmpdir(), `miras-actions-${process.pid}-${Date.now()}.db`);
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-actions-uploads-'));
process.env.MIRAS_UPLOADS_DIR = uploadsDir;
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'actions-test-secret';
process.env.SUPERADMIN_USERNAME = `actions_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'actions-test-password';

const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const userRoutes = require('../routes/users');
const messageRoutes = require('../routes/messages');

const app = express();
app.use(express.json());
app.set('io', { emit: () => {}, to: () => ({ emit: () => {} }) });
app.use('/api/users', userRoutes);
app.use('/api/messages', verifyToken, messageRoutes);

let server;
let baseUrl;

function createUser(username, { accountType = 'staff', role = null, groupName = null } = {}) {
  let groupId = null;
  if (groupName) {
    const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName);
    groupId = existing
      ? existing.id
      : Number(db.prepare('INSERT INTO groups (name) VALUES (?)').run(groupName).lastInsertRowid);
  }
  return Number(db.prepare(`
    INSERT INTO users (username, password, display_name, account_type, role, group_id)
    VALUES (?, 'x', ?, ?, ?, ?)
  `).run(username, username, accountType, role, groupId).lastInsertRowid);
}

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);

async function request(route, { token, method = 'GET' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(baseUrl + route, { method, headers });
  return { response, data: await response.json().catch(() => null) };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

// ===== Разделение типов аккаунтов =====

test('«Интернет» не видит ни сотрудников, ни модераторов, ни админов', async () => {
  const guest = createUser('acc_guest', { accountType: 'internet' });
  const otherGuest = createUser('acc_guest2', { accountType: 'internet' });
  createUser('acc_staff');
  createUser('acc_moder', { role: 'moderator' });
  createUser('acc_admin', { role: 'admin' });
  createUser('acc_admin_group', { groupName: 'Админы' });

  const { data } = await request('/api/users', { token: tokenFor(guest) });
  const names = data.map((u) => u.username);

  assert.deepEqual(names, ['acc_guest2'], `лишние люди в выдаче: ${names.join(', ')}`);
  assert.ok(names.includes(db.prepare('SELECT username FROM users WHERE id = ?').get(otherGuest).username));
});

test('модератор больше не видит «Интернет» — как и обычный сотрудник', async () => {
  const moderator = db.prepare("SELECT id FROM users WHERE username = 'acc_moder'").get().id;
  const staff = db.prepare("SELECT id FROM users WHERE username = 'acc_staff'").get().id;

  for (const [who, id] of [['модератор', moderator], ['сотрудник', staff]]) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await request('/api/users', { token: tokenFor(id) });
    const internet = data.filter((u) => u.username.startsWith('acc_guest'));
    assert.equal(internet.length, 0, `${who} видит аккаунты «Интернет»`);
  }
});

// ===== Очистка переписки =====

function seedChat(tag) {
  const a = createUser(`clr_a_${tag}`);
  const b = createUser(`clr_b_${tag}`);
  const chatId = `chat_${Math.min(a, b)}_${Math.max(a, b)}`;
  const insert = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, file_path) VALUES (?, ?, ?, ?)'
  );
  insert.run(chatId, a, 'первое сообщение', null);
  insert.run(chatId, b, 'ответ собеседника', null);
  insert.run(chatId, a, '', '/uploads/users/1/images/x.webp');
  return { a, b, chatId };
}

test('очистка помечает сообщения удалёнными, но содержимое остаётся в базе', async () => {
  const { a, chatId } = seedChat('ok');

  const { response, data } = await request(`/api/messages/${chatId}/clear`, {
    token: tokenFor(a), method: 'POST',
  });
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.cleared, 3);

  const rows = db.prepare('SELECT text, file_path, deleted FROM messages WHERE chat_id = ?').all(chatId);
  assert.equal(rows.length, 3, 'строки исчезли из базы — так нельзя, переписка хранится');
  assert.ok(rows.every((r) => r.deleted === 1));
  // Содержимое обязано остаться: «очистить» — это то же мягкое удаление.
  assert.ok(rows.some((r) => r.text === 'первое сообщение'));
  assert.ok(rows.some((r) => r.file_path === '/uploads/users/1/images/x.webp'));
});

test('очищенное не отдаётся наружу ни собеседнику, ни в превью', async () => {
  const { a, b, chatId } = seedChat('hidden');
  await request(`/api/messages/${chatId}/clear`, { token: tokenFor(a), method: 'POST' });

  const history = await request(`/api/messages/${chatId}`, { token: tokenFor(b) });
  for (const message of history.data.messages) {
    assert.equal(message.text, '', 'текст очищенного сообщения уехал собеседнику');
    assert.equal(message.file_path, null);
  }

  const last = await request('/api/messages/meta/last', { token: tokenFor(b) });
  assert.equal(last.data[chatId].text, '');
});

test('очистить можно только личную переписку, и только своим участникам', async () => {
  const { b, chatId } = seedChat('rights');
  const stranger = createUser('clr_stranger');

  const foreign = await request(`/api/messages/${chatId}/clear`, {
    token: tokenFor(stranger), method: 'POST',
  });
  assert.equal(foreign.response.status, 403);

  const group = await request('/api/messages/group_1/clear', { token: tokenFor(b), method: 'POST' });
  assert.equal(group.response.status, 400, 'группу очистить «у всех» нельзя');

  const general = await request('/api/messages/general/clear', { token: tokenFor(b), method: 'POST' });
  assert.equal(general.response.status, 400, 'общий чат очистить «у всех» нельзя');
});
