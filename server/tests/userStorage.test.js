const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

// Личные папки, архивация вложений и окно истории «от сообщения».
//
// Отдельным файлом от attachments.test.js: тут своя временная база и, главное,
// свои файлы на диске — перемешивать их с проверками загрузки значит зависеть
// от порядка тестов.

const dbPath = path.join(os.tmpdir(), `miras-storage-${process.pid}-${Date.now()}.db`);
// Свой каталог загрузок обязателен: миграция переносит файлы и правит пути
// в базе, и запуск по настоящим загрузкам с временной базой развёл бы файлы
// и строки в разные стороны — настоящие картинки уехали бы в чужие папки.
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-uploads-'));
process.env.MIRAS_UPLOADS_DIR = uploadsDir;
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'storage-test-secret';
process.env.SUPERADMIN_USERNAME = `storage_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'storage-test-password';

const db = require('../db');
const messageRoutes = require('../routes/messages');
const userStorage = require('../services/userStorage');
const { archiveAttachment, ArchiveError } = require('../services/attachmentArchive');

const UPLOADS = userStorage.UPLOADS_DIR;

const app = express();
app.use(express.json());
app.set('io', { emit: () => {}, to: () => ({ emit: () => {} }) });
app.use('/api/messages', messageRoutes);

let server;
let baseUrl;

const createUser = (username) => Number(db.prepare(
  'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
).run(username, 'x', username).lastInsertRowid);

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);

async function request(route, { token, method = 'GET' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(baseUrl + route, { method, headers });
  const data = await response.json().catch(() => null);
  return { response, data };
}

function seedChat(tag) {
  const a = createUser(`st_a_${tag}`);
  const b = createUser(`st_b_${tag}`);
  return { a, b, chatId: `chat_${Math.min(a, b)}_${Math.max(a, b)}` };
}

/** Кладёт файл на диск и возвращает публичный путь. */
function putFile(relative, content) {
  const abs = path.join(UPLOADS, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return `/uploads/${relative.split(path.sep).join('/')}`;
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

// ===== Раскладка по личным папкам =====

test('путь чужого вида и выход за uploads не проходят', () => {
  assert.equal(userStorage.parseUserPath('/uploads/users/7/files/../../db'), null);
  assert.equal(userStorage.parseUserPath('/uploads/users/7/secrets/a.txt'), null);
  assert.equal(userStorage.parseUserPath('/etc/passwd'), null);
  assert.equal(userStorage.absoluteFromPublic('/uploads/../db.js'), null);

  const parsed = userStorage.parseUserPath('/uploads/users/7/files/doc_7_1_ab.pdf');
  assert.deepEqual(parsed, { userId: 7, kind: 'files', filename: 'doc_7_1_ab.pdf' });
});

test('картинка сообщения ложится в папку отправителя и проходит проверку', async () => {
  const userId = createUser('st_image_owner');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'shot.png');

  const response = await fetch(`${baseUrl}/api/messages/upload-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(userId)}` },
    body: form,
  });
  const data = await response.json();

  assert.equal(response.status, 200, JSON.stringify(data));
  assert.match(data.file_path, new RegExp(`^/uploads/users/${userId}/images/msg_${userId}_`));
  assert.ok(fs.existsSync(userStorage.absoluteFromPublic(data.file_path)));
  // Тот же путь обязан проходить проверку при отправке сообщения по сокету.
  assert.equal(messageRoutes.isValidChatImagePath(data.file_path), true);
  // А чужая папка с тем же именем файла — нет: файла там не существует.
  assert.equal(
    messageRoutes.isValidChatImagePath(data.file_path.replace(`/users/${userId}/`, '/users/999999/')),
    false
  );
});

test('старые файлы переезжают в личные папки, а пути в базе переписываются', () => {
  const owner = createUser('st_legacy_owner');
  const mate = createUser('st_legacy_mate');
  const chatId = `chat_${Math.min(owner, mate)}_${Math.max(owner, mate)}`;

  const legacyImage = putFile(path.join('chat-images', `msg_${owner}_1_aaaa.webp`), 'картинка');
  const legacyDoc = putFile(path.join('chat-files', `doc_${owner}_1_bbbb.pdf`), 'документ');
  const legacyAvatar = putFile(path.join('avatars', `user_${owner}_1.jpg`), 'аватар');
  const legacyBg = putFile(path.join('backgrounds', `bg_${owner}_1.webp`), 'обои');
  // Файл, на который не ссылается ни одна строка: тоже должен уехать к хозяину,
  // иначе старый каталог никогда не опустеет.
  const orphan = putFile(path.join('chat-images', `msg_${owner}_2_cccc.webp`), 'сирота');

  const msgId = Number(db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, file_path) VALUES (?, ?, ?, ?)'
  ).run(chatId, owner, '', legacyImage).lastInsertRowid);
  // Пересланная копия ссылается на тот же файл — она обязана получить новый путь
  // тоже, иначе у одного из двух сообщений картинка пропадёт.
  const forwardedId = Number(db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, file_path) VALUES (?, ?, ?, ?)'
  ).run(chatId, mate, '', legacyImage).lastInsertRowid);
  db.prepare('INSERT INTO messages (chat_id, sender_id, text, document_path, document_name) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, owner, '', legacyDoc, 'смета.pdf');
  db.prepare('UPDATE users SET avatar_path = ?, chat_background_path = ? WHERE id = ?')
    .run(legacyAvatar, legacyBg, owner);

  const moved = userStorage.migrateLegacyUploads(db);

  const newImage = userStorage.publicPath(owner, 'images', path.basename(legacyImage));
  assert.equal(db.prepare('SELECT file_path FROM messages WHERE id = ?').get(msgId).file_path, newImage);
  // Пересылка — тот же файл, тот же владелец: путь общий.
  assert.equal(db.prepare('SELECT file_path FROM messages WHERE id = ?').get(forwardedId).file_path, newImage);
  const user = db.prepare('SELECT avatar_path, chat_background_path FROM users WHERE id = ?').get(owner);
  assert.equal(user.avatar_path, userStorage.publicPath(owner, 'avatar', path.basename(legacyAvatar)));
  assert.equal(user.chat_background_path, userStorage.publicPath(owner, 'wallpaper', path.basename(legacyBg)));

  // Файлы действительно лежат на новом месте, а старые исчезли.
  assert.ok(fs.existsSync(userStorage.absoluteFromPublic(newImage)));
  assert.equal(fs.existsSync(path.join(UPLOADS, 'chat-images', path.basename(legacyImage))), false);
  assert.ok(fs.existsSync(path.join(userStorage.userDir(owner, 'images'), path.basename(orphan))));
  assert.ok(moved.images >= 1 && moved.orphans >= 1);

  // Повторный запуск ничего не делает и не ломает: миграция идёт на каждом
  // старте сервера.
  const second = userStorage.migrateLegacyUploads(db);
  assert.equal(second.images + second.files + second.avatar + second.wallpaper + second.orphans, 0);
  assert.equal(db.prepare('SELECT file_path FROM messages WHERE id = ?').get(msgId).file_path, newImage);
});

// ===== Архивация вложения =====

function seedFileMessage(tag) {
  const { a, b, chatId } = seedChat(tag);
  const filePath = putFile(path.join('users', String(a), 'files', `doc_${a}_1_${tag}.txt`), 'секретная смета');
  const id = Number(db.prepare(`
    INSERT INTO messages (chat_id, sender_id, text, document_path, document_name, document_size, document_mime)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, a, 'вот смета', filePath, 'смета за август.pdf', 15, 'application/pdf').lastInsertRowid);
  return { a, b, chatId, id, filePath };
}

test('файл уезжает в zip под своим именем, а с диска исчезает', () => {
  const { a, id, filePath } = seedFileMessage('zip');
  const abs = userStorage.absoluteFromPublic(filePath);

  const result = archiveAttachment(id, a);

  assert.ok(result.archive_path, 'архив не создан');
  assert.match(result.archive_path, new RegExp(`^/uploads/users/${a}/archive/`));
  assert.equal(fs.existsSync(abs), false, 'исходник остался на диске');

  // Содержимое сохранено, и внутри архива лежит имя, под которым файл слали.
  const zip = new AdmZip(userStorage.absoluteFromPublic(result.archive_path));
  const entries = zip.getEntries().map((e) => e.entryName);
  assert.deepEqual(entries, ['смета за август.pdf']);
  assert.equal(zip.readAsText('смета за август.pdf'), 'секретная смета');

  // Само сообщение осталось: текст на месте, «удалённым» оно не стало.
  const row = db.prepare('SELECT text, deleted, attachment_archived_at FROM messages WHERE id = ?').get(id);
  assert.equal(row.text, 'вот смета');
  assert.equal(row.deleted, 0);
  assert.ok(row.attachment_archived_at);
});

test('убрать чужой файл нельзя, а убрать дважды — нечего', () => {
  const { a, b, id } = seedFileMessage('rights');

  assert.throws(() => archiveAttachment(id, b), (e) => e instanceof ArchiveError && e.status === 403);
  archiveAttachment(id, a);
  assert.throws(() => archiveAttachment(id, a), (e) => e instanceof ArchiveError && e.status === 409);
});

test('администрация может убрать чужое вложение, и архив ложится к владельцу', () => {
  const { a, b, id } = seedFileMessage('admin');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(b);

  const result = archiveAttachment(id, b);
  // Папка — отправителя, а не нажавшего: архив занимает место того, чей файл.
  assert.match(result.archive_path, new RegExp(`^/uploads/users/${a}/archive/`));
});

test('убранное вложение пропадает из истории, списков и превью чата', async () => {
  const { a, chatId, id } = seedFileMessage('hidden');
  archiveAttachment(id, a);

  const { data: history } = await request(`/api/messages/${chatId}`, { token: tokenFor(a) });
  const message = history.messages.find((m) => m.id === id);
  assert.equal(message.document_path, null, 'путь к убранному файлу уехал клиенту');
  assert.equal(message.text, 'вот смета', 'текст сообщения пострадал');
  assert.ok(message.attachment_archived_at, 'клиенту нечем показать, что вложение убрано');

  const { data: files } = await request(`/api/messages/${chatId}/attachments?kind=files`, { token: tokenFor(a) });
  assert.equal(files.items.length, 0, 'убранный файл остался в списке вложений');

  const { data: last } = await request('/api/messages/meta/last', { token: tokenFor(a) });
  assert.equal(last[chatId].document_name, null, 'убранный файл виден в превью списка чатов');
});

// ===== Категории вкладки «Файлы» =====

test('файлы делятся на документы, изображения, музыку и прочее', async () => {
  const { a, chatId } = seedChat('cat');
  const insert = db.prepare(`
    INSERT INTO messages (chat_id, sender_id, text, document_path, document_name, document_mime)
    VALUES (?, ?, '', ?, ?, ?)
  `);
  insert.run(chatId, a, '/uploads/users/1/files/a.pdf', 'договор.pdf', 'application/pdf');
  insert.run(chatId, a, '/uploads/users/1/files/b.png', 'скрин.png', 'image/png');
  insert.run(chatId, a, '/uploads/users/1/files/c.mp3', 'песня.mp3', 'audio/mpeg');
  insert.run(chatId, a, '/uploads/users/1/files/d.zip', 'архив.zip', 'application/zip');
  // MIME от телефона сплошь и рядом octet-stream — категорию решает расширение.
  insert.run(chatId, a, '/uploads/users/1/files/e.docx', 'акт.docx', 'application/octet-stream');
  // А без расширения выручает MIME.
  insert.run(chatId, a, '/uploads/users/1/files/f', 'запись', 'audio/ogg');

  const { data } = await request(`/api/messages/${chatId}/attachments?kind=files`, { token: tokenFor(a) });
  const byName = Object.fromEntries(data.items.map((i) => [i.document_name, i.category]));

  assert.equal(byName['договор.pdf'], 'documents');
  assert.equal(byName['скрин.png'], 'images');
  assert.equal(byName['песня.mp3'], 'music');
  assert.equal(byName['архив.zip'], 'files');
  assert.equal(byName['акт.docx'], 'documents');
  assert.equal(byName['запись'], 'music');
});

// ===== Окно истории «от сообщения» =====

test('история отдаёт окно от указанного сообщения до низа ленты', async () => {
  const { a, chatId } = seedChat('window');
  const insert = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)');
  const ids = [];
  for (let i = 0; i < 120; i += 1) ids.push(Number(insert.run(chatId, a, `строка ${i}`).lastInsertRowid));

  const target = ids[5];
  const { data } = await request(`/api/messages/${chatId}?from=${target}`, { token: tokenFor(a) });

  assert.equal(data.truncated, false);
  assert.equal(data.messages[0].id, target, 'окно начинается не с искомого сообщения');
  assert.equal(data.messages[data.messages.length - 1].id, ids[ids.length - 1], 'низ ленты потерян');
  // Выше искомого ещё есть история — значит подгрузка вверх обязана остаться.
  assert.equal(data.hasMore, true);
});

test('слишком далёкое сообщение честно помечается обрезанным, а не отдаёт дыру', async () => {
  const { a, chatId } = seedChat('far');
  const insert = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)');
  let first = null;
  for (let i = 0; i < 520; i += 1) {
    const id = Number(insert.run(chatId, a, `далеко ${i}`).lastInsertRowid);
    if (first === null) first = id;
  }

  const { data } = await request(`/api/messages/${chatId}?from=${first}`, { token: tokenFor(a) });
  assert.equal(data.truncated, true);
  assert.equal(data.messages.length, 0, 'обрезанное окно всё равно отдано — в ленте будет дыра');
});
