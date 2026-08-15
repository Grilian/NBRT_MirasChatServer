const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

// Раздел «Файлы» — личное хранилище. Главное, что проверяем: сюда попадает
// ТОЛЬКО своё (чужие файлы человек здесь удалять не должен и видеть их тут
// незачем) и не попадает убранное с удалённым.

const dbPath = path.join(os.tmpdir(), `miras-files-${process.pid}-${Date.now()}.db`);
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-files-uploads-'));
process.env.MIRAS_UPLOADS_DIR = uploadsDir;
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'files-test-secret';
process.env.SUPERADMIN_USERNAME = `files_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'files-test-password';

const db = require('../db');
const filesRoutes = require('../routes/files');

const app = express();
app.use(express.json());
app.use('/api/files', filesRoutes);

let server;
let baseUrl;

const createUser = (username) => Number(db.prepare(
  'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
).run(username, 'x', username).lastInsertRowid);

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);

async function get(route, token) {
  const response = await fetch(baseUrl + route, { headers: { Authorization: `Bearer ${token}` } });
  return { response, data: await response.json().catch(() => null) };
}

const insertDoc = db.prepare(`
  INSERT INTO messages (chat_id, sender_id, text, document_path, document_name, document_size, document_mime)
  VALUES (?, ?, '', ?, ?, ?, ?)
`);
const insertImage = db.prepare(
  'INSERT INTO messages (chat_id, sender_id, text, file_path, file_width, file_height) VALUES (?, ?, ?, ?, ?, ?)'
);

let me;
let mate;
let chatId;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  me = createUser('files_me');
  mate = createUser('files_mate');
  chatId = `chat_${Math.min(me, mate)}_${Math.max(me, mate)}`;

  insertDoc.run(chatId, me, '/uploads/users/1/files/a.pdf', 'договор.pdf', 1000, 'application/pdf');
  insertDoc.run(chatId, me, '/uploads/users/1/files/b.mp3', 'песня.mp3', 5000, 'audio/mpeg');
  insertDoc.run('general', me, '/uploads/users/1/files/c.zip', 'архив.zip', 300, 'application/zip');
  insertImage.run(chatId, me, '', '/uploads/users/1/images/x.webp', 100, 200);
  // Чужой файл в том же чате — в личном хранилище ему не место.
  insertDoc.run(chatId, mate, '/uploads/users/2/files/d.pdf', 'чужой.pdf', 700, 'application/pdf');
  // Удалённое сообщение вложения больше не отдаёт.
  db.prepare(`
    INSERT INTO messages (chat_id, sender_id, text, document_path, document_name, document_size, deleted)
    VALUES (?, ?, '', ?, ?, ?, 1)
  `).run(chatId, me, '/uploads/users/1/files/e.pdf', 'удалённый.pdf', 900);
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('в разделе только свои файлы, из всех чатов и с именем чата', async () => {
  const { data } = await get('/api/files', tokenFor(me));
  const names = data.items.map((i) => i.name);

  assert.ok(names.includes('договор.pdf'));
  assert.ok(names.includes('архив.zip'), 'файл из общего чата потерялся');
  assert.equal(names.includes('чужой.pdf'), false, 'чужой файл попал в личное хранилище');
  assert.equal(names.includes('удалённый.pdf'), false, 'вложение удалённого сообщения отдано наружу');

  const fromGeneral = data.items.find((i) => i.name === 'архив.zip');
  assert.equal(fromGeneral.chat_name, 'Общий чат');
  const direct = data.items.find((i) => i.name === 'договор.pdf');
  assert.equal(direct.chat_name, 'files_mate', 'у личной переписки показано не имя собеседника');
});

test('картинка тоже файл: у неё вид image и осмысленное имя вместо msg_…webp', async () => {
  const { data } = await get('/api/files', tokenFor(me));
  const image = data.items.find((i) => i.kind === 'image');

  assert.ok(image, 'картинки не попали в раздел');
  assert.equal(image.category, 'images');
  assert.match(image.name, /^Изображение от \d{4}-\d{2}-\d{2}$/);
  assert.ok(image.can_open, 'переход к сообщению должен быть доступен участнику чата');
});

test('категории и сортировка приходят с сервера, а не считаются на глаз', async () => {
  const { data } = await get('/api/files?sort=big', tokenFor(me));
  const sizes = data.items.filter((i) => i.size).map((i) => i.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'сортировка по размеру не применилась');

  const byName = Object.fromEntries(data.items.map((i) => [i.name, i.category]));
  assert.equal(byName['договор.pdf'], 'documents');
  assert.equal(byName['песня.mp3'], 'music');
  assert.equal(byName['архив.zip'], 'files');
});

test('поиск отбирает по имени', async () => {
  const { data } = await get(`/api/files?search=${encodeURIComponent('песн')}`, tokenFor(me));
  assert.deepEqual(data.items.map((i) => i.name), ['песня.mp3']);
});

test('сводка считает занятое место по видам файлов', async () => {
  const { data } = await get('/api/files/summary', tokenFor(me));

  assert.equal(data.total_bytes, 6300, 'сложены не те файлы');
  assert.equal(data.documents_count, 3);
  assert.equal(data.images_count, 1);
  assert.equal(data.bytes_by_category.documents, 1000);
  assert.equal(data.bytes_by_category.music, 5000);
  assert.equal(data.bytes_by_category.files, 300);
});

test('убранное в архив уходит из основного списка и попадает в архивный', async () => {
  const target = db.prepare('SELECT id FROM messages WHERE document_name = ?').get('песня.mp3');
  db.prepare('UPDATE messages SET attachment_archived_at = ? WHERE id = ?').run(Date.now(), target.id);

  const active = await get('/api/files', tokenFor(me));
  assert.equal(active.data.items.some((i) => i.name === 'песня.mp3'), false);

  const archived = await get('/api/files?archived=1', tokenFor(me));
  assert.deepEqual(archived.data.items.map((i) => i.name), ['песня.mp3']);
  assert.ok(archived.data.items[0].archived_at, 'нет отметки времени архивации');

  const summary = await get('/api/files/summary', tokenFor(me));
  assert.equal(summary.data.total_bytes, 1300, 'убранный файл всё ещё занимает место в сводке');
  assert.equal(summary.data.archived_count, 1);
});

test('без токена раздел не отдаётся', async () => {
  const response = await fetch(`${baseUrl}/api/files`);
  assert.equal(response.status, 401);
});
