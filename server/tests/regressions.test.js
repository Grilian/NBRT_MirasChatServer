const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const dbPath = path.join(os.tmpdir(), `miras-regressions-${process.pid}-${Date.now()}.db`);
// Свой каталог загрузок обязателен: без него тест пишет в боевой server/uploads
// и запускает там миграцию личных папок поверх настоящих файлов при временной БД.
process.env.MIRAS_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-regressions-uploads-'));
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
const emojiRoutes = require('../routes/emoji');
const stickerRoutes = require('../routes/stickers');
const { isValidBirthDate } = require('../utils/validators');
const { markRead } = require('../services/readReceipts');
const { archiveAndDeleteUser } = require('../services/accountArchive');
const { getReactionEmoji, setReactionEmoji } = require('../services/appSettings');
const { isValidEmoji } = require('../services/reactions');

const emitted = [];
const io = {
  emit: (event, payload) => emitted.push({ room: null, event, payload }),
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
app.use('/api/emoji', emojiRoutes);
app.use('/api/stickers', stickerRoutes);

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

const superAdminToken = () => jwt.sign({ id: 1, role: 'superadmin' }, process.env.JWT_SECRET);

/**
 * GET с `If-None-Match` без самодеятельности fetch.
 *
 * Node-овский fetch подмешивает в запрос `Cache-Control: no-cache`, из-за чего
 * сервер обязан ответить полным телом, — проверить условный запрос им нельзя.
 */
function conditionalGet(route, token, etag) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + route);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
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

// Само удаление файла с диска — fire-and-forget (fs.unlink с колбэком, никем не
// awaited вплоть до самого HTTP-ответа): так устроено в проде специально, чтобы
// ответ не ждал файловую систему. В тесте это означает, что сразу после ответа
// сервера файл иногда ещё физически на месте — не баг, а гонка на стороне
// теста. Ждём столько, сколько разумно для локального диска, а не проверяем
// синхронно.
async function waitForFileGone(filePath, timeoutMs = 500) {
  const started = Date.now();
  while (fs.existsSync(filePath)) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

// Бейдж чата обязан гаснуть от прочтения самого чата. Ответы веток в его ленту
// не попадают, значит и в его счётчик идти не могут — иначе он застревает
// навсегда: снять его нечем, ленту человек уже прочитал целиком.
test('chat unread counter covers only what opening the chat marks read', async () => {
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
  });

  assert.equal(legacy.response.status, 200);
  assert.equal(modern.response.status, 200);
  assert.equal(legacy.data[chatId], 1);
  assert.equal(modern.data[chatId], 1);

  // Прочитано всё, что видно в ленте чата, — бейдж должен исчезнуть целиком.
  markRead(recipientId, chatId, [rootId]);
  const afterReading = await request('/api/unread', {
    token,
  });
  assert.equal(afterReading.data[chatId], undefined);
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

test('catalogs are revalidatable: ETag plus Cache-Control', async () => {
  // Каталог смайликов — 1,19 МБ без сжатия, и он перечитывается всеми
  // клиентами при каждой правке в панели. ETag Express выдаёт сам, но БЕЗ
  // Cache-Control ответ не считается кэшируемым: браузер вправе не оставить
  // копию вовсе, а тогда и переспрашивать нечем — приезжает весь каталог.
  //
  // Именно 'no-cache' («храни, но каждый раз переспрашивай»), а НЕ 'no-store':
  // no-store запрещает хранить, то есть сделал бы ровно то, от чего уходим.
  const userId = createUser('catalog_reader');
  const token = tokenFor(userId);

  for (const route of ['/api/emoji/catalog', '/api/stickers/catalog']) {
    const first = await request(route, { token });
    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers.get('cache-control'), 'no-cache', route);

    const etag = first.response.headers.get('etag');
    assert.ok(etag, `нет ETag у ${route}`);

    // Условный запрос идёт через node:http, а НЕ через fetch. Node-овский
    // fetch (undici) добавляет к запросу свои `Cache-Control: no-cache` и
    // `Pragma: no-cache`, а это по стандарту значит «не переиспользуй кэш» —
    // Express честно отвечает 200 с полным телом. Тест на fetch «доказывал»
    // бы, что условные запросы не работают, хотя curl на том же сервере
    // получает 304. Ловушка среды, не поведение приложения.
    const second = await conditionalGet(route, token, etag);
    assert.equal(second.status, 304, route);
    assert.equal(second.body.length, 0, `${route} отдал тело вместе с 304`);
  }
});

test('group name has a length limit — otherwise "do not truncate" is unenforceable', async () => {
  // Предела не было вовсе, и это не абстрактная дыра: имя чата показывается в
  // шапке переписки БЕЗ обрезки (там человек убеждается, в каком он чате), и
  // без предела на сервере шапка превращалась бы в стену текста. Самое
  // длинное название на проде — 18 знаков, так что 120 никого не стесняет.
  const ownerId = createUser('long_name_owner');
  const token = tokenFor(ownerId);
  const tooLong = 'я'.repeat(121);

  const created = await request('/api/groups', { token, method: 'POST', body: { name: tooLong } });
  assert.equal(created.response.status, 400);

  const ok = await request('/api/groups', { token, method: 'POST', body: { name: 'я'.repeat(120) } });
  assert.equal(ok.response.status, 200);

  // Переименование обязано проверять то же самое: иначе предел обходится в
  // два шага — создать коротким именем и тут же переименовать.
  const renamed = await request(`/api/groups/${ok.data.id}`, {
    token, method: 'PUT', body: { name: tooLong },
  });
  assert.equal(renamed.response.status, 400);
  const row = db.prepare('SELECT name FROM chat_groups WHERE id = ?').get(ok.data.id);
  assert.equal(row.name.length, 120);
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

/**
 * Смайлик вместе с его оформлением.
 *
 * С 07.09.2026 путь к картинке принадлежит emoji_assets, а не колонке на
 * элементе: у emoji_items нет ни file_path, ни animated_path, их считает
 * представление emoji_items_resolved. Поэтому засеять «смайлик с картинкой»
 * одним INSERT больше нельзя — нужна пара строк.
 */
function seedEmojiItem(packId, { name = null, fallback = null, unicodeKey = null, position = 0, filePath, packKey = 'apple' }) {
  const itemId = Number(db.prepare(`
    INSERT INTO emoji_items (pack_id, emoji, name, fallback_emoji, unicode_key, retired, position)
    VALUES (?, '', ?, ?, ?, 0, ?)
  `).run(packId, name, fallback, unicodeKey, position).lastInsertRowid);
  const assetPackId = db.prepare('SELECT id FROM emoji_asset_packs WHERE key = ?').get(packKey).id;
  db.prepare(
    'INSERT INTO emoji_assets (item_id, asset_pack_id, file_path, created_at) VALUES (?, ?, ?, ?)'
  ).run(itemId, assetPackId, filePath, Date.now());
  return itemId;
}

test('набор реакций не ограничен двенадцатью и берётся из живого каталога', () => {
  db.prepare("DELETE FROM app_settings WHERE key = 'reaction_emoji'").run();
  const packId = db.prepare(
    'INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES (?, ?, 1, ?)'
  ).run('Unlimited reactions test', 999, Date.now()).lastInsertRowid;

  // Реакции хранятся обычными символами Unicode. Коды `:u_1f601:` сняты
  // 07.09.2026 вместе со всей подсистемой имён; показывается реакция всё равно
  // картинкой — клиент находит символ в каталоге отрисовки.
  const symbols = ['🥇', '🥈', '🥉', '🏅', '🎖️', '🏆', '🎗️', '🎀', '🎁', '🎈', '🎉', '🎊', '🪅', '🧨', '✨'];
  symbols.forEach((symbol, index) => {
    seedEmojiItem(packId, {
      name: `reaction_test_${index}`, fallback: symbol, position: index,
      filePath: `/uploads/emoji/reaction_test_${index}.webp`,
    });
  });

  // Пятнадцать штук — больше прежнего предела в двенадцать, и все сохраняются.
  assert.deepEqual(setReactionEmoji(symbols), symbols);
  assert.deepEqual(getReactionEmoji(), symbols);

  // Того, чего нет в каталоге, в наборе не будет: список задаётся выбором из
  // каталога, произвольная строка сюда попасть не должна.
  assert.deepEqual(setReactionEmoji([...symbols, '🛸']), symbols);

  // Пустой набор возвращает значения по умолчанию, а не оставляет пустоту.
  assert.ok(setReactionEmoji([]).length > 0);

  assert.equal(isValidEmoji('👍'), true);
  assert.equal(isValidEmoji('a'.repeat(35)), false);
});

test('порядок паков смайликов сохраняется полным списком', async () => {
  const admin = superAdminToken();
  const firstCreated = await request('/api/emoji/admin', {
    token: admin, method: 'POST', body: { name: 'Первый emoji-пак', emoji: '' },
  });
  assert.equal(firstCreated.response.status, 201, JSON.stringify(firstCreated.data));
  const firstId = firstCreated.data.find((p) => p.name === 'Первый emoji-пак').id;
  const secondCreated = await request('/api/emoji/admin', {
    token: admin, method: 'POST', body: { name: 'Второй emoji-пак', emoji: '' },
  });
  assert.equal(secondCreated.response.status, 201, JSON.stringify(secondCreated.data));
  const secondId = secondCreated.data.find((p) => p.name === 'Второй emoji-пак').id;
  const order = secondCreated.data.map((p) => p.id);
  const firstIndex = order.indexOf(firstId);
  const secondIndex = order.indexOf(secondId);
  [order[firstIndex], order[secondIndex]] = [order[secondIndex], order[firstIndex]];

  const reordered = await request('/api/emoji/admin/reorder', {
    token: admin, method: 'PUT', body: { order },
  });
  assert.equal(reordered.response.status, 200);
  assert.ok(reordered.data.findIndex((p) => p.id === secondId) < reordered.data.findIndex((p) => p.id === firstId));
});

test('ZIP-набор связывает составное имя с Unicode и попадает в каталог', async () => {
  const image = await sharp({
    create: { width: 12, height: 12, channels: 4, background: { r: 255, g: 180, b: 0, alpha: 1 } },
  }).png().toBuffer();
  const archive = new AdmZip();
  archive.addFile('U+1F1E6-U+1F1E8.png', image);
  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'flags.zip');
  form.append('key', 'apple-test');
  form.append('name', 'Apple Test');
  form.append('role', 'base');

  const imported = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${superAdminToken()}` },
    body: form,
  });
  const payload = await imported.json();
  assert.equal(imported.status, 200, JSON.stringify(payload));
  assert.equal(payload.report.imported, 1);

  const item = db.prepare(`
    SELECT unicode_key, fallback_emoji FROM emoji_items WHERE unicode_key = '1f1e6-1f1e8'
  `).get();
  assert.deepEqual(item, { unicode_key: '1f1e6-1f1e8', fallback_emoji: '🇦🇨' });
});

test('удаление пака — настоящее, без архива: файлы с диска и emoji_assets уходят вместе с ним', async () => {
  const admin = superAdminToken();
  const created = await request('/api/emoji/admin', {
    token: admin, method: 'POST', body: { name: 'Пак под снос', emoji: '' },
  });
  const packId = created.data.find((p) => p.name === 'Пак под снос').id;

  // Элемент с настоящим файлом на диске. Раньше он заводился через ручку
  // загрузки картиночного смайлика — её больше нет вместе с самим понятием,
  // поэтому кладём напрямую: проверяем удаление пака, а не загрузку.
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  }).webp().toBuffer();
  const filename = `emoji_doomed_${Date.now()}.webp`;
  const dir = path.join(process.env.MIRAS_UPLOADS_DIR, 'emoji');
  fs.mkdirSync(dir, { recursive: true });
  const onDisk = path.join(dir, filename);
  fs.writeFileSync(onDisk, image);
  const publicPath = `/uploads/emoji/${filename}`;

  db.prepare(
    "INSERT INTO emoji_items (pack_id, emoji, unicode_key, fallback_emoji, position) VALUES (?, '', 'test-doomed-key', '🧪', 998)"
  ).run(packId);
  const itemId = db.prepare('SELECT id FROM emoji_items WHERE unicode_key = ?').get('test-doomed-key').id;
  db.prepare(
    'INSERT INTO emoji_assets (item_id, asset_pack_id, file_path, created_at) VALUES (?, 1, ?, ?)'
  ).run(itemId, publicPath, Date.now());

  // Второй элемент — с ресурсом, но без файла на диске: раньше на такой
  // опирался ТОЛЬКО декоративный ON DELETE CASCADE (PRAGMA foreign_keys
  // выключена во всём проекте), и без явной подчистки он повис бы сиротой.
  db.prepare(
    "INSERT INTO emoji_items (pack_id, emoji, unicode_key, fallback_emoji, position) VALUES (?, '', 'test-orphan-key', '🧪', 999)"
  ).run(packId);
  const unicodeItemId = db.prepare('SELECT id FROM emoji_items WHERE unicode_key = ?').get('test-orphan-key').id;
  db.prepare(
    'INSERT INTO emoji_assets (item_id, asset_pack_id, file_path, created_at) VALUES (?, 1, ?, ?)'
  ).run(unicodeItemId, '/uploads/emoji/does-not-matter.webp', Date.now());

  const removed = await request(`/api/emoji/admin/${packId}`, { token: admin, method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.find((p) => p.id === packId), undefined, 'пак должен исчезнуть из списка');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ?').get(packId).c, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM emoji_assets WHERE item_id = ?').get(unicodeItemId).c, 0,
    'emoji_assets юникодного элемента не должны пережить удаление пака сиротой',
  );
  assert.ok(await waitForFileGone(onDisk), 'файл картинки должен быть удалён с диска, а не архивирован');

  // И никакого архива не появилось — вся суть фикса.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM emoji_packs WHERE name = 'Архив смайликов'").get().c, 0);
});

test('удаление набора оформления (ZIP) реально возможно и подчищает файлы с диска', async () => {
  const admin = superAdminToken();
  const image = await sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 9, g: 8, b: 7, alpha: 1 } },
  }).png().toBuffer();
  const archive = new AdmZip();
  archive.addFile('U+1F600.png', image);
  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'set.zip');
  form.append('key', 'deletable-set');
  form.append('name', 'Набор под снос');
  form.append('role', 'base');
  const imported = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin}` },
    body: form,
  });
  assert.equal(imported.status, 200);

  const assetPackId = db.prepare("SELECT id FROM emoji_asset_packs WHERE key = 'deletable-set'").get().id;
  const asset = db.prepare('SELECT file_path FROM emoji_assets WHERE asset_pack_id = ?').get(assetPackId);
  const onDisk = path.join(process.env.MIRAS_UPLOADS_DIR, asset.file_path.replace(/^\/uploads\//, ''));
  assert.ok(fs.existsSync(onDisk));

  const removed = await request(`/api/emoji/admin/assets/${assetPackId}`, { token: admin, method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
  assert.equal(
    removed.data.assetPacks.find((p) => p.id === assetPackId), undefined,
    'удалённый набор не должен возвращаться в списке',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM emoji_assets WHERE asset_pack_id = ?').get(assetPackId).c, 0);
  assert.ok(await waitForFileGone(onDisk), 'файл набора должен быть удалён с диска');

  // Повторное удаление того же id — уже не существует, честная 404, а не тихий успех.
  const again = await request(`/api/emoji/admin/assets/${assetPackId}`, { token: admin, method: 'DELETE' });
  assert.equal(again.response.status, 404);
});

test('юникодный элемент без картинки виден как символ, даже если рядом в паке уже есть элементы с картинками', async () => {
  const packId = db.prepare(
    'INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES (?, ?, 1, ?)'
  ).run('Смешанный пак', 998, Date.now()).lastInsertRowid;
  // С картинкой — элемент, у которого есть ресурс во включённом базовом наборе.
  seedEmojiItem(packId, {
    name: 'u_mixed_test_a', fallback: '😀', unicodeKey: 'mixed-test-key-a', position: 0,
    filePath: '/uploads/emoji/u_mixed_test_a.webp',
  });
  // Без картинки — структура импортирована, но конкретный набор оформления
  // для этого ключа ещё не загружен. Раньше такой элемент не показывался НИ
  // картинкой, ни текстом: код смотрел на item.emoji (у новой системы это
  // всегда '' — сам символ лежит в fallback_emoji), и элемент просто исчезал.
  db.prepare(`
    INSERT INTO emoji_items (pack_id, emoji, fallback_emoji, unicode_key, position)
    VALUES (?, '', '😬', 'mixed-test-key-b', 1)
  `).run(packId);

  const list = await request('/api/emoji', { token: tokenFor(createUser('emoji_public_viewer')) });
  const pack = list.data.find((p) => p.id === packId || p.name === 'Смешанный пак');
  assert.ok(pack, 'пак должен присутствовать в публичной выдаче');
  assert.equal(pack.custom.length, 1, 'элемент с картинкой идёт отдельным списком custom');
  assert.equal(pack.custom[0].unicode_key, 'mixed-test-key-a');
  assert.deepEqual(pack.emoji, ['😬'], 'элемент без картинки обязан быть виден как сам символ');
});

test('элемент с картинками из двух наборов несёт variants — для попапа выбора пака в композере', async () => {
  const admin = superAdminToken();
  const appleImage = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  }).png().toBuffer();
  const googleImage = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 40, g: 50, b: 60, alpha: 1 } },
  }).png().toBuffer();

  // Тот же самый ключ (1f973 — 🥳) загружается в оба базовых набора: тот, что
  // уже сидирован при старте (apple, id=1), и новый (google-fonts).
  const appleArchive = new AdmZip();
  appleArchive.addFile('U+1F973.png', appleImage);
  const appleForm = new FormData();
  appleForm.append('archive', new Blob([appleArchive.toBuffer()], { type: 'application/zip' }), 'apple.zip');
  appleForm.append('key', 'apple');
  appleForm.append('name', 'Apple');
  appleForm.append('role', 'base');
  const appleImport = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: appleForm,
  });
  assert.equal(appleImport.status, 200);

  const googleArchive = new AdmZip();
  googleArchive.addFile('U+1F973.png', googleImage);
  const googleForm = new FormData();
  googleForm.append('archive', new Blob([googleArchive.toBuffer()], { type: 'application/zip' }), 'google.zip');
  googleForm.append('key', 'google-fonts');
  googleForm.append('name', 'Google Fonts');
  googleForm.append('role', 'base');
  const googleImport = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: googleForm,
  });
  assert.equal(googleImport.status, 200);

  const list = await request('/api/emoji', { token: tokenFor(createUser('emoji_variants_viewer')) });
  const item = list.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f973');
  assert.ok(item, 'элемент 🥳 должен присутствовать в выдаче');
  assert.ok(Array.isArray(item.variants), 'у элемента с двумя оформлениями обязан быть список variants');
  assert.equal(item.variants.length, 2);
  assert.deepEqual(
    item.variants.map((v) => v.packKey).sort(),
    ['apple', 'google-fonts'],
  );

  // А для одного набора — apple, вообще без конкурентов — поля variants нет
  // вовсе: выбирать не из чего, и раздувать выдачу нечем.
  const single = db.prepare(`
    INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES ('Одиночный', 997, 1, ?)
  `).run(Date.now()).lastInsertRowid;
  seedEmojiItem(single, {
    name: 'u_solo_test', fallback: '🧊', unicodeKey: 'solo-test-key', position: 0,
    filePath: '/uploads/emoji/u_solo_test.webp',
  });

  const list2 = await request('/api/emoji', { token: tokenFor(createUser('emoji_variants_viewer_2')) });
  const soloItem = list2.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === 'solo-test-key');
  assert.ok(soloItem);
  assert.equal(soloItem.variants, undefined, 'у элемента с единственным оформлением variants быть не должно');
});

test('анимационный набор не попадает в выбор оформления — он не альтернатива, а та же картинка в движении', async () => {
  const admin = superAdminToken();
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 90, g: 20, b: 20, alpha: 1 } },
  }).png().toBuffer();

  // Один и тот же ключ уходит в базовый набор и в анимационный. Пока сюда
  // попадали обе роли, у смайлика появлялся «выбор» из Apple и Telegram —
  // хотя выбирать нечего: это одна и та же картинка, просто в движении.
  for (const [key, name, role] of [['apple', 'Apple', 'base'], ['animation', 'Telegram Animation', 'animation']]) {
    const archive = new AdmZip();
    archive.addFile('U+1F60E.png', image);
    const form = new FormData();
    form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), `${key}.zip`);
    form.append('key', key);
    form.append('name', name);
    form.append('role', role);
    const res = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
      method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form,
    });
    assert.equal(res.status, 200);
  }

  const list = await request('/api/emoji', { token: tokenFor(createUser('emoji_anim_viewer')) });
  const item = list.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f60e');
  assert.ok(item, 'элемент 😎 должен быть в выдаче');
  assert.equal(item.variants, undefined, 'анимация не должна давать второй «вариант оформления»');
  assert.ok(item.animated_path, 'при этом сама анимация обязана доехать отдельным полем');
});

test('тона кожи схлопываются под базовый смайлик в панели выбора, но не в каталоге отрисовки', async () => {
  const admin = superAdminToken();
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 160, b: 120, alpha: 1 } },
  }).png().toBuffer();

  // 👍 и все пять его тонов — ровно тот случай, из-за которого раздел «Люди и
  // тело» разрастался до 2251 карточки при 387 настоящих смайликах.
  const archive = new AdmZip();
  archive.addFile('U+1F44D.png', image);
  for (const tone of ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF']) {
    archive.addFile(`U+1F44D-U+${tone}.png`, image);
  }
  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'tones.zip');
  form.append('key', 'apple');
  form.append('name', 'Apple');
  form.append('role', 'base');
  const imported = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form,
  });
  assert.equal(imported.status, 200);

  const viewer = tokenFor(createUser('emoji_tone_viewer'));
  const picker = await request('/api/emoji', { token: viewer });
  const cards = picker.data.flatMap((p) => p.custom || []).filter((c) => String(c.unicode_key || '').startsWith('1f44d'));
  assert.equal(cards.length, 1, 'в панели выбора 👍 должен остаться ОДНОЙ карточкой');
  assert.equal(cards[0].unicode_key, '1f44d');
  assert.equal(cards[0].tones.length, 5, 'все пять тонов обязаны приехать вложенно');
  assert.deepEqual(
    cards[0].tones.map((t) => t.unicode_key),
    ['1f44d-1f3fb', '1f44d-1f3fc', '1f44d-1f3fd', '1f44d-1f3fe', '1f44d-1f3ff'],
    'порядок тонов — от светлого к тёмному, как в Unicode',
  );

  // А в каталоге ОТРИСОВКИ они обязаны лежать россыпью: в отправленном
  // сообщении хранится именно тоновый символ, и показать его нужно им же, а
  // не базовым 👍 другого цвета.
  const catalog = await request('/api/emoji/catalog', { token: viewer });
  const toned = catalog.data.filter((c) => String(c.unicode_key || '').startsWith('1f44d'));
  assert.equal(toned.length, 6, 'каталог отрисовки схлопывать тона не имеет права');
});

test('селектор начертания fe0f не мешает найти базовую версию', async () => {
  const admin = superAdminToken();
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 30, g: 90, b: 140, alpha: 1 } },
  }).png().toBuffer();

  // Ровно тот случай, из-за которого «часть объединилась, часть нет»: Unicode
  // выбрасывает fe0f, как только применён тон кожи. 🏋️ это `1f3cb-fe0f`, а
  // 🏋🏻 — уже `1f3cb-1f3fb`. Сравнение «ключ минус тон» базу не находило.
  const archive = new AdmZip();
  archive.addFile('U+1F3CB-U+FE0F.png', image);
  archive.addFile('U+1F3CB-U+1F3FB.png', image);
  archive.addFile('U+1F3CB-U+1F3FF.png', image);
  // И тот же fe0f ВНУТРИ ZWJ-последовательности: 🏋️‍♀️ против 🏋🏻‍♀️.
  archive.addFile('U+1F3CB-U+FE0F-U+200D-U+2640-U+FE0F.png', image);
  archive.addFile('U+1F3CB-U+1F3FB-U+200D-U+2640-U+FE0F.png', image);

  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'fe0f.zip');
  form.append('key', 'apple');
  form.append('name', 'Apple');
  form.append('role', 'base');
  assert.equal((await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form,
  })).status, 200);

  const picker = await request('/api/emoji', { token: tokenFor(createUser('emoji_fe0f_viewer')) });
  const cards = picker.data.flatMap((p) => p.custom || [])
    .filter((c) => String(c.unicode_key || '').startsWith('1f3cb'));

  assert.equal(cards.length, 2, 'должны остаться две карточки: 🏋️ и 🏋️‍♀️, а не пять');
  const plain = cards.find((c) => c.unicode_key === '1f3cb-fe0f');
  const woman = cards.find((c) => c.unicode_key === '1f3cb-fe0f-200d-2640-fe0f');
  assert.ok(plain && woman, 'базовыми обязаны стать версии С селектором начертания');
  assert.equal(plain.tones.length, 2);
  assert.equal(woman.tones.length, 1);
});

test('тоновый набор без базовой версии сворачивается под первую вариацию, а не рассыпается', async () => {
  const admin = superAdminToken();
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 120, g: 60, b: 90, alpha: 1 } },
  }).png().toBuffer();

  // «Держатся за руки» без тонов кодируется ОДНИМ символом (👬 = 1f46c), а с
  // тонами — ZWJ-последовательностью, незатонированной формы которой в
  // каталоге нет вовсе. Прятать такие нельзя, а двадцать карточек подряд —
  // ровно та простыня, от которой уходим.
  const archive = new AdmZip();
  archive.addFile('U+1F468-U+1F3FB-U+200D-U+1F91D-U+200D-U+1F468-U+1F3FC.png', image);
  archive.addFile('U+1F468-U+1F3FC-U+200D-U+1F91D-U+200D-U+1F468-U+1F3FD.png', image);
  archive.addFile('U+1F468-U+1F3FD-U+200D-U+1F91D-U+200D-U+1F468-U+1F3FE.png', image);

  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'pairs.zip');
  form.append('key', 'apple');
  form.append('name', 'Apple');
  form.append('role', 'base');
  assert.equal((await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form,
  })).status, 200);

  const picker = await request('/api/emoji', { token: tokenFor(createUser('emoji_pairs_viewer')) });
  const cards = picker.data.flatMap((p) => p.custom || [])
    .filter((c) => String(c.unicode_key || '').includes('1f91d'));

  assert.equal(cards.length, 1, 'вся группа обязана свернуться в одну карточку');
  // Представитель сам остаётся среди тонов — в попапе он подсвечен как текущий.
  assert.equal(cards[0].tones.length, 3);
});

// Импорт архива с одним ключом в указанный набор — ради тестов панели правки.
async function importOne(admin, { key, name, role, files }) {
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 70, g: 130, b: 180, alpha: 1 } },
  }).png().toBuffer();
  const archive = new AdmZip();
  files.forEach((f) => archive.addFile(f, image));
  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), `${key}.zip`);
  form.append('key', key);
  form.append('name', name);
  form.append('role', role);
  const res = await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form,
  });
  assert.equal(res.status, 200);
}

test('выключенный смайлик уходит из панели выбора, но остаётся в каталоге отрисовки', async () => {
  const admin = superAdminToken();
  await importOne(admin, { key: 'apple', name: 'Apple', role: 'base', files: ['U+1F4A9.png'] });

  const viewer = tokenFor(createUser('emoji_off_viewer'));
  const before = await request('/api/emoji', { token: viewer });
  const item = before.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f4a9');
  assert.ok(item, 'до выключения смайлик в панели есть');

  const off = await request(`/api/emoji/admin/custom/${item.id}/enabled`, {
    token: admin, method: 'PUT', body: { enabled: false },
  });
  assert.equal(off.response.status, 200);

  const after = await request('/api/emoji', { token: viewer });
  assert.equal(
    after.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f4a9'), undefined,
    'из панели выбора выключенный смайлик обязан пропасть',
  );

  // А в переписке он остаётся: текст сообщения не меняется, и подменять архив
  // системным глифом задним числом мы не должны.
  const catalog = await request('/api/emoji/catalog', { token: viewer });
  assert.ok(
    catalog.data.find((c) => c.unicode_key === '1f4a9'),
    'каталог отрисовки выключение не затрагивает',
  );
});

test('выключение базового смайлика уносит и все его тона', async () => {
  const admin = superAdminToken();
  await importOne(admin, {
    key: 'apple', name: 'Apple', role: 'base',
    files: ['U+270C-U+FE0F.png', 'U+270C-U+1F3FB.png', 'U+270C-U+1F3FF.png'],
  });

  const viewer = tokenFor(createUser('emoji_tone_off_viewer'));
  const before = await request('/api/emoji', { token: viewer });
  const card = before.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '270c-fe0f');
  assert.ok(card && card.tones.length === 2);

  const off = await request(`/api/emoji/admin/custom/${card.id}/enabled`, {
    token: admin, method: 'PUT', body: { enabled: false },
  });
  assert.equal(off.data.changed, 3, 'выключиться обязаны базовый и оба тона');

  const after = await request('/api/emoji', { token: viewer });
  const left = after.data.flatMap((p) => p.custom || [])
    .filter((c) => String(c.unicode_key || '').startsWith('270c'));
  assert.equal(left.length, 0, 'ни базовый, ни тона не должны остаться в панели');
});

test('выключенная версия отдаёт смайлик следующему набору, а не прячет его', async () => {
  const admin = superAdminToken();
  await importOne(admin, { key: 'apple', name: 'Apple', role: 'base', files: ['U+1F984.png'] });
  await importOne(admin, { key: 'second', name: 'Второй', role: 'base', files: ['U+1F984.png'] });

  const viewer = tokenFor(createUser('emoji_asset_off_viewer'));
  const before = await request('/api/emoji', { token: viewer });
  const item = before.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f984');
  assert.match(item.file_path, /emoji_apple_/, 'по умолчанию — активный Apple');

  const applePack = db.prepare("SELECT id FROM emoji_asset_packs WHERE key = 'apple'").get();
  const off = await request(`/api/emoji/admin/assets/${applePack.id}/items/${item.id}`, {
    token: admin, method: 'PUT', body: { enabled: false },
  });
  assert.equal(off.response.status, 200);

  const after = await request('/api/emoji', { token: viewer });
  const moved = after.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f984');
  assert.ok(moved, 'смайлик обязан остаться — у него есть другая версия');
  assert.match(moved.file_path, /emoji_second_/, 'и показаться следующим включённым набором');
});

test('порядок наборов оформления задаётся списком и решает, откуда брать картинку', async () => {
  const admin = superAdminToken();
  const packs = db.prepare('SELECT id FROM emoji_asset_packs ORDER BY position, id').all().map((r) => r.id);

  const bad = await request('/api/emoji/admin/assets/reorder', {
    token: admin, method: 'PUT', body: { order: packs.slice(1) },
  });
  assert.equal(bad.response.status, 400, 'неполный список — отказ');

  const reversed = [...packs].reverse();
  const ok = await request('/api/emoji/admin/assets/reorder', {
    token: admin, method: 'PUT', body: { order: reversed },
  });
  assert.equal(ok.response.status, 200);
  assert.deepEqual(
    db.prepare('SELECT id FROM emoji_asset_packs ORDER BY position, id').all().map((r) => r.id),
    reversed,
  );
});

test('раздел из загруженной структуры удалить нельзя — это снесло бы картинки наборов', async () => {
  const admin = superAdminToken();
  const packId = db.prepare(`
    INSERT INTO emoji_packs (name, position, enabled, created_at, structure_key)
    VALUES ('Раздел из структуры', 996, 1, ?, 'unicode:test-guard')
  `).run(Date.now()).lastInsertRowid;

  const removed = await request(`/api/emoji/admin/${packId}`, { token: admin, method: 'DELETE' });
  assert.equal(removed.response.status, 400);
  assert.match(removed.data.error, /структуры/);
  assert.ok(db.prepare('SELECT id FROM emoji_packs WHERE id = ?').get(packId), 'раздел остался на месте');

  // И состав такого раздела нельзя переписать строкой смайликов.
  const replaced = await request(`/api/emoji/admin/${packId}`, {
    token: admin, method: 'PUT', body: { emoji: '😀 😁' },
  });
  assert.equal(replaced.response.status, 400);
});

test('сами модификаторы тона — самостоятельные смайлики, а не чьи-то вариации', async () => {
  const admin = superAdminToken();
  const image = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } },
  }).png().toBuffer();

  const archive = new AdmZip();
  archive.addFile('U+1F3FB.png', image);
  const form = new FormData();
  form.append('archive', new Blob([archive.toBuffer()], { type: 'application/zip' }), 'mods.zip');
  form.append('key', 'apple');
  form.append('name', 'Apple');
  form.append('role', 'base');
  assert.equal((await fetch(`${baseUrl}/api/emoji/admin/assets/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` }, body: form,
  })).status, 200);

  const picker = await request('/api/emoji', { token: tokenFor(createUser('emoji_mod_viewer')) });
  const mod = picker.data.flatMap((p) => p.custom || []).find((c) => c.unicode_key === '1f3fb');
  assert.ok(mod, '🏻 обязан остаться отдельной карточкой — прятать его не под что');
  assert.equal(mod.tones, undefined);
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
