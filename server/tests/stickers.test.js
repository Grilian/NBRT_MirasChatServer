const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbPath = path.join(os.tmpdir(), `miras-stickers-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'stickers-test-secret';
process.env.SUPERADMIN_USERNAME = `sticker_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'sticker-test-password';

const db = require('../db');
const stickerRoutes = require('../routes/stickers');
const messageRoutes = require('../routes/messages');

const emitted = [];
const io = { emit: (event, payload) => emitted.push({ event, payload }) };

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/stickers', stickerRoutes);
app.use('/api/messages', messageRoutes);

let server;
let baseUrl;

function createUser(username) {
  return Number(db.prepare(
    'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
  ).run(username, 'x', username).lastInsertRowid);
}

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
const superAdminToken = () => jwt.sign({ id: 1, role: 'superadmin' }, process.env.JWT_SECRET);

async function request(route, { token, method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(baseUrl + route, { method, headers, body: payload });
  const data = await response.json();
  return { response, data };
}

// Крошечный, но настоящий PNG (1×1) — sharp обязан суметь его декодировать,
// пустой буфер здесь не подойдёт.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function stickerForm(emoji) {
  const form = new FormData();
  form.append('image', new Blob([TINY_PNG], { type: 'image/png' }), 'sticker.png');
  if (emoji !== undefined) form.append('emoji', emoji);
  return form;
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('пикер видит только включённые паки без выключенных/убранных стикеров', async () => {
  const admin = superAdminToken();
  const created = await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак для пикера' },
  });
  const packId = created.data.find((p) => p.name === 'Пак для пикера').id;

  const uploaded = await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('😀'),
  });
  assert.equal(uploaded.response.status, 201);
  const itemId = uploaded.data.id;

  const picker = await request('/api/stickers', { token: tokenFor(createUser('picker_user')) });
  const pack = picker.data.find((p) => p.id === packId);
  assert.ok(pack, 'включённый пак виден в пикере');
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].emoji, '😀');

  // Выключенный пак пропадает из пикера целиком.
  await request(`/api/stickers/admin/${packId}`, { token: admin, method: 'PUT', body: { enabled: false } });
  const afterDisable = await request('/api/stickers', { token: tokenFor(createUser('picker_user_2')) });
  assert.equal(afterDisable.data.find((p) => p.id === packId), undefined);
});

test('каталог отдаёт стикер независимо от enabled пака — для отрисовки старых сообщений', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Каталожный пак' },
  })).data.find((p) => p.name === 'Каталожный пак').id;
  await request(`/api/stickers/admin/${packId}`, { token: admin, method: 'PUT', body: { enabled: false } });

  const uploaded = await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('🎈'),
  });
  const itemId = uploaded.data.id;

  const catalog = await request('/api/stickers/catalog', { token: tokenFor(createUser('catalog_user')) });
  const entry = catalog.data.find((s) => s.id === itemId);
  assert.ok(entry, 'выключенный пак всё равно отдаёт свои стикеры в каталог');
  assert.equal(entry.emoji, '🎈');
});

test('отправленный стикер несёт sticker_id и sticker_fallback в истории чата', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак для сообщений' },
  })).data.find((p) => p.name === 'Пак для сообщений').id;
  const itemId = (await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('🔥'),
  })).data.id;

  // Сокет-обработчик chat_message здесь не поднимается (в проекте нет
  // харнеса для живого сокета — остальные тесты по той же причине проверяют
  // socket-путь через прямую вставку строки), поэтому воспроизводим ровно то,
  // что делает server/index.js при валидном stickerId: подставляет id и
  // копирует emoji элемента в sticker_fallback на момент отправки.
  const senderId = createUser('sticker_sender');
  const stickerRow = db.prepare('SELECT id, emoji FROM sticker_items WHERE id = ?').get(itemId);
  const messageId = Number(db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text, sticker_id, sticker_fallback) VALUES ('general', ?, '', ?, ?)"
  ).run(senderId, stickerRow.id, stickerRow.emoji).lastInsertRowid);

  const history = await request('/api/messages/general?limit=10', { token: tokenFor(senderId) });
  assert.equal(history.response.status, 200, JSON.stringify(history.data));
  const found = history.data.messages.find((m) => m.id === messageId);
  assert.ok(found, 'отправленный стикер виден в истории');
  assert.equal(found.sticker_id, stickerRow.id);
  assert.equal(found.sticker_fallback, stickerRow.emoji);
});

test('удалённое сообщение со стикером не отдаёт наружу ни картинку, ни заглушку', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак для удалённого' },
  })).data.find((p) => p.name === 'Пак для удалённого').id;
  const itemId = (await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('👻'),
  })).data.id;

  const senderId = createUser('sticker_deleted_message_sender');
  const messageId = Number(db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text, sticker_id, sticker_fallback, deleted) VALUES ('general', ?, '', ?, ?, 1)"
  ).run(senderId, itemId, '👻').lastInsertRowid);

  const history = await request('/api/messages/general?limit=10', { token: tokenFor(senderId) });
  const found = history.data.messages.find((m) => m.id === messageId);
  assert.ok(found);
  // Удаление — юридическое обязательство хранить строку, но наружу из нЕё не
  // должно попасть ничего, включая стикер (тот же принцип, что у text/file_path).
  assert.equal(found.sticker_id, null);
  assert.equal(found.sticker_fallback, null);
});

test('удаление стикера в админке НЕ ломает старое сообщение — остаётся sticker_fallback', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак на удаление' },
  })).data.find((p) => p.name === 'Пак на удаление').id;
  const itemId = (await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('💥'),
  })).data.id;

  const senderId = createUser('sticker_deletion_sender');
  db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text, sticker_id, sticker_fallback) VALUES ('general', ?, '', ?, ?)"
  ).run(senderId, itemId, '💥');

  const usage = await request(`/api/stickers/admin/items/${itemId}/usage`, { token: admin });
  assert.equal(usage.data.count, 1);

  const del = await request(`/api/stickers/admin/items/${itemId}`, { token: admin, method: 'DELETE' });
  assert.equal(del.response.status, 200);

  // Элемент реально пропал из каталога...
  const catalog = await request('/api/stickers/catalog', { token: tokenFor(senderId) });
  assert.equal(catalog.data.find((s) => s.id === itemId), undefined);

  // ...но у сообщения остался эмодзи-заглушка на замену пропавшей картинки —
  // ровно то решение, о котором договорились для отличия от смайликов.
  const row = db.prepare('SELECT sticker_id, sticker_fallback FROM messages WHERE sender_id = ? AND text = \'\'')
    .get(senderId);
  assert.equal(row.sticker_id, itemId);
  assert.equal(row.sticker_fallback, '💥');
});

test('удаление пака переносит стикеры в архив, а не роняет их каскадом', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак под снос' },
  })).data.find((p) => p.name === 'Пак под снос').id;
  const itemId = (await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('🗑️'),
  })).data.id;

  const del = await request(`/api/stickers/admin/${packId}`, { token: admin, method: 'DELETE' });
  assert.equal(del.response.status, 200);
  assert.equal(del.data.find((p) => p.id === packId), undefined, 'сам пак удалён');

  const archive = del.data.find((p) => p.name === 'Архив стикеров');
  assert.ok(archive, 'архив завёлся');
  const movedItem = archive.items.find((i) => i.id === itemId);
  assert.ok(movedItem, 'стикер пережил удаление пака');
  assert.equal(movedItem.retired, true);

  // Архив нельзя удалить — иначе те же стикеры пропали бы каскадом уже отсюда.
  const archiveDelete = await request(`/api/stickers/admin/${archive.id}`, { token: admin, method: 'DELETE' });
  assert.equal(archiveDelete.response.status, 400);
});

test('порядок стикеров меняется полным списком id (drag-and-drop с клиента)', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак для порядка' },
  })).data.find((p) => p.name === 'Пак для порядка').id;
  const first = (await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('1️⃣'),
  })).data.id;
  const second = (await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm('2️⃣'),
  })).data.id;

  const reordered = await request(`/api/stickers/admin/${packId}/items/reorder`, {
    token: admin, method: 'PUT', body: { order: [second, first] },
  });
  const pack = reordered.data.find((p) => p.id === packId);
  assert.deepEqual(pack.items.map((i) => i.id), [second, first]);

  // Список, не совпадающий с реальным составом пака, отклоняется.
  const bogus = await request(`/api/stickers/admin/${packId}/items/reorder`, {
    token: admin, method: 'PUT', body: { order: [first, 999999] },
  });
  assert.equal(bogus.response.status, 400);
});

test('загрузка без эмодзи отклоняется — он обязателен как метаданные и fallback', async () => {
  const admin = superAdminToken();
  const packId = (await request('/api/stickers/admin', {
    token: admin, method: 'POST', body: { name: 'Пак без эмодзи' },
  })).data.find((p) => p.name === 'Пак без эмодзи').id;

  const uploaded = await request(`/api/stickers/admin/${packId}/items`, {
    token: admin, method: 'POST', form: stickerForm(undefined),
  });
  assert.equal(uploaded.response.status, 400);
});

test('обычный пользователь не может управлять паками', async () => {
  const packId = (await request('/api/stickers/admin', {
    token: superAdminToken(), method: 'POST', body: { name: 'Защищённый пак' },
  })).data.find((p) => p.name === 'Защищённый пак').id;

  const attempt = await request(`/api/stickers/admin/${packId}`, {
    token: tokenFor(createUser('not_an_admin')), method: 'PUT', body: { enabled: false },
  });
  assert.equal(attempt.response.status, 403);
});
