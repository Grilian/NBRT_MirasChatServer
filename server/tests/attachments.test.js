const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbPath = path.join(os.tmpdir(), `miras-attachments-${process.pid}-${Date.now()}.db`);
const updatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-updates-'));
process.env.MIRAS_DB_PATH = dbPath;
process.env.MIRAS_UPDATES_DIR = updatesDir;
process.env.JWT_SECRET = 'attachments-test-secret';
process.env.SUPERADMIN_USERNAME = `attach_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'attach-test-password';

const db = require('../db');
const messageRoutes = require('../routes/messages');
const superadminRoutes = require('../routes/superadmin');
const { listReleases, activateRelease } = require('../services/releases');

const app = express();
app.use(express.json());
app.set('io', { emit: () => {}, to: () => ({ emit: () => {} }) });
app.use('/api/messages', messageRoutes);
app.use('/api/superadmin', superadminRoutes);

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
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(baseUrl + route, { method, headers, body: payload });
  const data = await response.json().catch(() => null);
  return { response, data };
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
  fs.rmSync(updatesDir, { recursive: true, force: true });
});

// ===== Загрузка файлов =====

test('файл загружается и отдаёт имя, размер и путь', async () => {
  const userId = createUser('file_uploader');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('привет, это документ')], { type: 'text/plain' }), 'смета за август.txt');

  const { response, data } = await request('/api/messages/upload-file', {
    token: tokenFor(userId), method: 'POST', form,
  });

  assert.equal(response.status, 200, JSON.stringify(data));
  // Оригинальное имя сохраняется для показа человеку...
  assert.equal(data.name, 'смета за август.txt');
  // ...а на диск уезжает обеззараженное: кириллица и пробелы туда не идут.
  // ...и ложится в личную папку отправителя, а не в общую кучу.
  assert.match(data.file_path, new RegExp(`^/uploads/users/${userId}/files/doc_\\d+_\\d+_[a-f0-9]+\\.txt$`));
  assert.equal(data.size, Buffer.from('привет, это документ').length);
});

test('файл больше 50 МБ отклоняется с объяснением про тестовый режим', async () => {
  const userId = createUser('file_too_big');
  // 50 МБ + 1 байт: ровно за границей.
  const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
  const form = new FormData();
  form.append('file', new Blob([oversized], { type: 'application/octet-stream' }), 'big.bin');

  const { response, data } = await request('/api/messages/upload-file', {
    token: tokenFor(userId), method: 'POST', form,
  });

  assert.equal(response.status, 413);
  assert.equal(data.code, 'file_too_large');
  // Требование: человеку сообщается про тестовый режим, а не «ошибка загрузки».
  assert.match(data.error, /тестовом режиме/i);
  assert.match(data.error, /50 МБ/);
});

test('путь файла от клиента не принимается на веру', () => {
  const { isValidChatFilePath } = messageRoutes;
  assert.equal(isValidChatFilePath('/uploads/chat-files/../../db.sqlite'), false);
  assert.equal(isValidChatFilePath('/etc/passwd'), false);
  assert.equal(isValidChatFilePath('/uploads/chat-images/msg_1.webp'), false);
  // Не существующий на диске путь тоже не проходит.
  assert.equal(isValidChatFilePath('/uploads/chat-files/doc_1_1_deadbeef.txt'), false);
});

// ===== Вложения переписки: Медиа / Файлы / Ссылки =====

function seedChat() {
  const a = createUser(`att_a_${Math.random().toString(36).slice(2, 8)}`);
  const b = createUser(`att_b_${Math.random().toString(36).slice(2, 8)}`);
  const chatId = `chat_${Math.min(a, b)}_${Math.max(a, b)}`;
  return { a, b, chatId };
}

test('«Медиа» отдаёт только картинки этого чата, новые первыми', async () => {
  const { a, b, chatId } = seedChat();
  const insert = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, file_path, file_width, file_height) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insert.run(chatId, a, '', '/uploads/chat-images/one.webp', 100, 200);
  insert.run(chatId, b, 'с подписью', '/uploads/chat-images/two.webp', 300, 400);
  db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)').run(chatId, a, 'просто текст');
  // Чужой чат в выдачу попадать не должен.
  insert.run('general', a, '', '/uploads/chat-images/other.webp', 10, 10);

  const { response, data } = await request(`/api/messages/${chatId}/attachments?kind=media`, {
    token: tokenFor(a),
  });
  assert.equal(response.status, 200);
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].file_path, '/uploads/chat-images/two.webp');
  assert.equal(data.items[0].file_width, 300);
});

test('«Файлы» отдаёт документы с именем и размером', async () => {
  const { a, chatId } = seedChat();
  db.prepare(`
    INSERT INTO messages (chat_id, sender_id, text, document_path, document_name, document_size, document_mime)
    VALUES (?, ?, '', ?, ?, ?, ?)
  `).run(chatId, a, '/uploads/chat-files/doc_1.pdf', 'договор.pdf', 12345, 'application/pdf');

  const { data } = await request(`/api/messages/${chatId}/attachments?kind=files`, { token: tokenFor(a) });
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].document_name, 'договор.pdf');
  assert.equal(data.items[0].document_size, 12345);
});

test('«Ссылки» вытаскиваются из текста и не дублируются', async () => {
  const { a, chatId } = seedChat();
  const insert = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)');
  insert.run(chatId, a, 'смотри https://example.com/page и www.other.ru');
  insert.run(chatId, a, 'ещё раз https://example.com/page');
  insert.run(chatId, a, 'тут ссылок нет');
  // Хвостовая точка в адрес не входит.
  insert.run(chatId, a, 'зайди на https://tail.example.com.');

  const { data } = await request(`/api/messages/${chatId}/attachments?kind=links`, { token: tokenFor(a) });
  const urls = data.items.map((i) => i.url);

  assert.ok(urls.includes('https://example.com/page'));
  assert.ok(urls.includes('www.other.ru'));
  assert.ok(urls.includes('https://tail.example.com'), `хвостовая точка не срезана: ${urls.join(', ')}`);
  // Один и тот же адрес — одна строка справочника, сколько бы раз его ни слали.
  assert.equal(urls.filter((u) => u === 'https://example.com/page').length, 1);
  // www-адрес получает схему для перехода, но показывается как есть.
  assert.equal(data.items.find((i) => i.url === 'www.other.ru').href, 'https://www.other.ru');
});

test('удалённое и скрытое во вложения не попадают', async () => {
  const { a, chatId } = seedChat();
  const insert = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, file_path, deleted) VALUES (?, ?, ?, ?, ?)'
  );
  insert.run(chatId, a, '', '/uploads/chat-images/visible.webp', 0);
  insert.run(chatId, a, '', '/uploads/chat-images/deleted.webp', 1);
  const hiddenId = Number(insert.run(chatId, a, '', '/uploads/chat-images/hidden.webp', 0).lastInsertRowid);
  db.prepare('INSERT INTO message_hidden (message_id, user_id, hidden_at) VALUES (?, ?, ?)')
    .run(hiddenId, a, Date.now());

  const { data } = await request(`/api/messages/${chatId}/attachments?kind=media`, { token: tokenFor(a) });
  const paths = data.items.map((i) => i.file_path);
  assert.deepEqual(paths, ['/uploads/chat-images/visible.webp']);
});

test('вложения чужого чата недоступны', async () => {
  const { chatId } = seedChat();
  const outsider = createUser('att_outsider');
  const { response } = await request(`/api/messages/${chatId}/attachments?kind=media`, {
    token: tokenFor(outsider),
  });
  assert.equal(response.status, 403);
});

// ===== Откат версии =====

function seedRelease(version, versionCode) {
  fs.writeFileSync(path.join(updatesDir, `MirasChat Setup ${version}.exe`), `exe-${version}`);
  fs.writeFileSync(path.join(updatesDir, `MirasChat-${version}-debug.apk`), `apk-${version}`);
  fs.writeFileSync(path.join(updatesDir, 'android.json'), JSON.stringify({
    versionCode, versionName: version, url: `https://x/${version}.apk`, size: 1,
  }));
  fs.writeFileSync(path.join(updatesDir, 'latest.yml'), `version: ${version}\n`);
  // Читаем — тем самым versionCode попадает в реестр.
  listReleases();
}

test('список сборок показывает, что лежит на сервере и что раздаётся', () => {
  seedRelease('1.9.0', 51);
  seedRelease('1.10.0', 52);

  const state = listReleases();
  assert.equal(state.available, true);
  // Сортировка числовая: 1.10.0 новее 1.9.0, а не наоборот по алфавиту.
  assert.deepEqual(state.releases.map((r) => r.version), ['1.10.0', '1.9.0']);
  assert.equal(state.current.windows, '1.10.0');
  assert.equal(state.current.android, '1.10.0');
});

test('откат переписывает манифесты на старую сборку, не удаляя файлы', () => {
  const result = activateRelease('1.9.0');
  assert.ok(result.changed.includes('Windows'));
  assert.ok(result.changed.includes('Android'));

  const yml = fs.readFileSync(path.join(updatesDir, 'latest.yml'), 'utf8');
  assert.match(yml, /^version: 1\.9\.0$/m);
  // sha512 считается с файла на диске, а не переносится из старого манифеста.
  assert.match(yml, /^sha512: .+$/m);
  assert.match(yml, /MirasChat Setup 1\.9\.0\.exe/);

  const android = JSON.parse(fs.readFileSync(path.join(updatesDir, 'android.json'), 'utf8'));
  assert.equal(android.versionName, '1.9.0');
  // versionCode взят из реестра, а не выдуман.
  assert.equal(android.versionCode, 51);

  // Файл новой версии остался — вернуться вперёд можно тем же способом.
  assert.ok(fs.existsSync(path.join(updatesDir, 'MirasChat Setup 1.10.0.exe')));
});

test('откат на несуществующую версию отклоняется', () => {
  assert.throws(() => activateRelease('9.9.9'), /нет на сервере/);
  assert.throws(() => activateRelease('не-версия'), /Некорректный номер/);
});

test('откат доступен только супер-админу', async () => {
  const stranger = await request('/api/superadmin/releases', { token: tokenFor(createUser('rel_stranger')) });
  assert.equal(stranger.response.status, 403);

  const admin = await request('/api/superadmin/releases', { token: superAdminToken() });
  assert.equal(admin.response.status, 200);
  assert.equal(admin.data.available, true);
});

test('откат не применяется наполовину, когда для платформы нет данных', () => {
  // 1.9.0 выложена «до появления реестра»: versionCode Android неизвестен.
  // Раньше запись шла по ходу проверок, и latest.yml успевал перезаписаться
  // ДО отказа по Android — админ видел ошибку, а Windows уже откатился.
  fs.writeFileSync(path.join(updatesDir, 'releases.json'), JSON.stringify({
    androidVersionCodes: { '1.10.0': 52 },
  }));
  fs.writeFileSync(path.join(updatesDir, 'latest.yml'), 'version: 1.10.0\n');
  fs.writeFileSync(path.join(updatesDir, 'android.json'), JSON.stringify({
    versionCode: 52, versionName: '1.10.0', url: 'https://x/a.apk', size: 1,
  }));

  const result = activateRelease('1.9.0');

  // Windows откатился и об этом сказано...
  assert.deepEqual(result.changed, ['Windows']);
  assert.match(fs.readFileSync(path.join(updatesDir, 'latest.yml'), 'utf8'), /^version: 1\.9\.0$/m);
  // ...а про Android сказано отдельно, а не молча пропущено.
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /Android/);
  // android.json остался нетронутым — состояние согласовано с отчётом.
  const android = JSON.parse(fs.readFileSync(path.join(updatesDir, 'android.json'), 'utf8'));
  assert.equal(android.versionName, '1.10.0');
});
