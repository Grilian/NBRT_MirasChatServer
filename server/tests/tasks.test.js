const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// У задач НЕ БЫЛО ни одного серверного теста, при том что там живут права
// доступа и — с 07.09.2026 — мягкое удаление с журналом. Потерю здесь не видно
// ни на одном скриншоте: она выглядит как «задача пропала», и разбираться
// приходится в базе.

const dbPath = path.join(os.tmpdir(), `miras-tasks-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-tasks-uploads-'));
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'tasks-test-secret';
process.env.SUPERADMIN_USERNAME = `tasks_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'tasks-test-password';

const db = require('../db');
const taskRoutes = require('../routes/tasks');

const io = { emit: () => {}, to: () => ({ emit: () => {} }) };

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/tasks', taskRoutes);

let server;
let baseUrl;

function createUser(username) {
  const password = bcrypt.hashSync('valid-password', 4);
  const result = db.prepare(
    'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
  ).run(username, password, username);
  return Number(result.lastInsertRowid);
}

const tokenFor = (id) => jwt.sign({ id, username: `user_${id}`, source: 'local' }, process.env.JWT_SECRET);

async function request(route, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => new Promise((resolve) => server.close(resolve)));

/** Задача от `author`, где `assignee` — исполнитель (и, значит, причастный). */
async function makeTask(authorToken, over = {}) {
  const { response, data } = await request('/api/tasks', {
    token: authorToken, method: 'POST', body: { title: 'Проверить фонд', ...over },
  });
  assert.equal(response.status, 201);
  return data;
}

test('исполнитель один и он же становится причастным', async () => {
  // Иначе назначенный человек не увидел бы того, что ему поручили: видимость
  // считается по составу причастных.
  const author = createUser('t_author_1');
  const worker = createUser('t_worker_1');
  const task = await makeTask(tokenFor(author), { assignee_id: worker });

  assert.equal(task.assignee.id, worker);
  assert.deepEqual(task.participants.map((p) => p.id), [worker]);

  const mine = await request('/api/tasks', { token: tokenFor(worker) });
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].id, task.id);
});

test('передать задачу может постановщик или текущий исполнитель, но не наблюдатель', async () => {
  // Сдать свою работу другому — нормальный ход; наблюдатель не решает, с кого
  // спрос.
  const author = createUser('t_author_2');
  const worker = createUser('t_worker_2');
  const watcher = createUser('t_watcher_2');
  const next = createUser('t_next_2');
  const task = await makeTask(tokenFor(author), {
    assignee_id: worker, participant_ids: [worker, watcher],
  });

  const byWatcher = await request(`/api/tasks/${task.id}/assignee`, {
    token: tokenFor(watcher), method: 'PUT', body: { assignee_id: next },
  });
  assert.equal(byWatcher.response.status, 403);

  const byWorker = await request(`/api/tasks/${task.id}/assignee`, {
    token: tokenFor(worker), method: 'PUT', body: { assignee_id: next },
  });
  assert.equal(byWorker.response.status, 200);
  assert.equal(byWorker.data.assignee.id, next);
  // Новый исполнитель обязан оказаться среди причастных — иначе не увидит.
  assert.ok(byWorker.data.participants.some((p) => p.id === next));
});

test('исполнителя можно снять — задача возвращается в общий пул', async () => {
  const author = createUser('t_author_3');
  const worker = createUser('t_worker_3');
  const task = await makeTask(tokenFor(author), { assignee_id: worker });

  const { response, data } = await request(`/api/tasks/${task.id}/assignee`, {
    token: tokenFor(author), method: 'PUT', body: { assignee_id: null },
  });
  assert.equal(response.status, 200);
  assert.equal(data.assignee, null);
});

test('удаление без причины не проходит', async () => {
  // Пустая причина заполнила бы журнал строками, по которым ничего не понять,
  // то есть отменила бы его смысл.
  const author = createUser('t_author_4');
  const task = await makeTask(tokenFor(author));

  const empty = await request(`/api/tasks/${task.id}`, {
    token: tokenFor(author), method: 'DELETE', body: { reason: '   ' },
  });
  assert.equal(empty.response.status, 400);

  const none = await request(`/api/tasks/${task.id}`, {
    token: tokenFor(author), method: 'DELETE', body: {},
  });
  assert.equal(none.response.status, 400);

  // Задача на месте: отказ обязан быть отказом, а не «удалил, но без причины».
  const list = await request('/api/tasks', { token: tokenFor(author) });
  assert.equal(list.data.length, 1);
});

test('удалить может ЛЮБОЙ причастный, и строка остаётся в базе', async () => {
  const author = createUser('t_author_5');
  const worker = createUser('t_worker_5');
  const task = await makeTask(tokenFor(author), { assignee_id: worker });

  const del = await request(`/api/tasks/${task.id}`, {
    token: tokenFor(worker), method: 'DELETE', body: { reason: 'Создан дубль' },
  });
  assert.equal(del.response.status, 200);

  // Из обычных списков пропала у всех, включая постановщика...
  const authorList = await request('/api/tasks', { token: tokenFor(author) });
  assert.equal(authorList.data.length, 0);
  // ...но физически осталась: раньше здесь был DELETE FROM tasks.
  const row = db.prepare('SELECT deleted_at, delete_reason FROM tasks WHERE id = ?').get(task.id);
  assert.ok(row.deleted_at);
  assert.equal(row.delete_reason, 'Создан дубль');
});

test('журнал показывает автора удаления, причину и статус НА МОМЕНТ удаления', async () => {
  const author = createUser('t_author_6');
  const worker = createUser('t_worker_6');
  const task = await makeTask(tokenFor(author), { assignee_id: worker });

  await request(`/api/tasks/${task.id}/status`, {
    token: tokenFor(worker), method: 'PUT', body: { status: 'in_progress' },
  });
  await request(`/api/tasks/${task.id}`, {
    token: tokenFor(worker), method: 'DELETE', body: { reason: 'Заказ отменён читателем' },
  });

  // Постановщик обязан увидеть, куда делась его задача: удалить мог не он.
  const journal = await request('/api/tasks/journal', { token: tokenFor(author) });
  assert.equal(journal.response.status, 200);
  assert.equal(journal.data.length, 1);
  const entry = journal.data[0];
  assert.equal(entry.id, task.id);
  assert.equal(entry.deleted_by.id, worker);
  assert.equal(entry.delete_reason, 'Заказ отменён читателем');
  assert.equal(entry.deleted_status, 'in_progress');
});

test('в журнал попадают только СВОИ задачи', async () => {
  const author = createUser('t_author_7');
  const stranger = createUser('t_stranger_7');
  const task = await makeTask(tokenFor(author));
  await request(`/api/tasks/${task.id}`, {
    token: tokenFor(author), method: 'DELETE', body: { reason: 'Не актуально' },
  });

  const mine = await request('/api/tasks/journal', { token: tokenFor(author) });
  assert.ok(mine.data.some((row) => row.id === task.id));

  const alien = await request('/api/tasks/journal', { token: tokenFor(stranger) });
  assert.equal(alien.data.length, 0);
});

test('восстановление возвращает задачу в работу, а запись журнала не подчищает', async () => {
  // Возврат исправляет ровно ту ошибку, которую открывает право «удалить может
  // любой»: убрал чужую задачу не глядя.
  const author = createUser('t_author_8');
  const worker = createUser('t_worker_8');
  const task = await makeTask(tokenFor(author), { assignee_id: worker });
  await request(`/api/tasks/${task.id}`, {
    token: tokenFor(worker), method: 'DELETE', body: { reason: 'Ошибся' },
  });

  const restored = await request(`/api/tasks/${task.id}/restore`, {
    token: tokenFor(author), method: 'PUT',
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.data.deleted, false);

  const list = await request('/api/tasks', { token: tokenFor(author) });
  assert.equal(list.data.length, 1);

  // Журнал отвечает на «что происходило» — подчистить его значит снова
  // остаться без ответа. Восстановленная задача из него уходит (она больше не
  // удалена), но сам факт остаётся в базе.
  const journal = await request('/api/tasks/journal', { token: tokenFor(author) });
  assert.equal(journal.data.length, 0);
});

test('удалённую задачу нельзя ни править, ни двигать по статусам', async () => {
  const author = createUser('t_author_9');
  const task = await makeTask(tokenFor(author));
  await request(`/api/tasks/${task.id}`, {
    token: tokenFor(author), method: 'DELETE', body: { reason: 'Дубль' },
  });

  const edit = await request(`/api/tasks/${task.id}`, {
    token: tokenFor(author), method: 'PUT', body: { title: 'Другое' },
  });
  assert.equal(edit.response.status, 404);

  const status = await request(`/api/tasks/${task.id}/status`, {
    token: tokenFor(author), method: 'PUT', body: { status: 'done' },
  });
  assert.equal(status.response.status, 404);
});

test('источник задачи запоминается копией имени, а не ссылкой на чат', async () => {
  // Чат могут переименовать или удалить, а карточка обязана помнить, откуда
  // задача пришла.
  const author = createUser('t_author_10');
  const task = await makeTask(tokenFor(author), {
    source_kind: 'chat', source_ref: 'group_7', source_label: 'Методисты',
  });

  assert.deepEqual(task.source, { kind: 'chat', ref: 'group_7', label: 'Методисты' });
});

test('несуществующий источник не принимается', async () => {
  // «Заказ книг» в схеме заложен, но внешней базы нет даже в договорённостях:
  // принять такой источник значит завести данные, которыми нечем управлять.
  const author = createUser('t_author_11');
  const task = await makeTask(tokenFor(author), { source_kind: 'order', source_ref: '4821' });

  assert.equal(task.source.kind, 'manual');
  assert.equal(task.source.ref, null);
});

test('миграция: единственный причастный стал исполнителем', async () => {
  // На проде задач четыре, у каждой ровно один причастный — перенос
  // однозначен. Там, где причастных несколько, угадывать нельзя.
  const author = createUser('t_author_12');
  const worker = createUser('t_worker_12');
  const other = createUser('t_other_12');
  const now = Date.now();

  const one = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, status, created_at, updated_at)
    VALUES ('Старая одиночная', ?, 'done', ?, ?)
  `).run(author, now, now).lastInsertRowid);
  db.prepare('INSERT INTO task_participants (task_id, user_id) VALUES (?, ?)').run(one, worker);

  const many = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, status, created_at, updated_at)
    VALUES ('Старая на двоих', ?, 'done', ?, ?)
  `).run(author, now, now).lastInsertRowid);
  db.prepare('INSERT INTO task_participants (task_id, user_id) VALUES (?, ?)').run(many, worker);
  db.prepare('INSERT INTO task_participants (task_id, user_id) VALUES (?, ?)').run(many, other);

  require('../db/steps/09-tasks')(db);

  assert.equal(db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(one).assignee_id, worker);
  assert.equal(db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(many).assignee_id, null);
});
