const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `miras-threads-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_DB_PATH = dbPath;
process.env.SUPERADMIN_USERNAME = `thread_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'thread-test-password';

const db = require('../db');
const {
  ThreadError,
  attachThreadSummaries,
  getThread,
  hideThread,
  listThreadsForUser,
  markThreadRead,
  rootForUser,
  softDeleteThread,
} = require('../services/threads');

function createUser(username) {
  return Number(db.prepare(
    'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
  ).run(username, 'x', username).lastInsertRowid);
}

function insertMessage(chatId, senderId, text, rootId = null) {
  return Number(db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, thread_root_id) VALUES (?, ?, ?, ?)'
  ).run(chatId, senderId, text, rootId).lastInsertRowid);
}

function expectThreadError(code, action) {
  assert.throws(action, (error) => error instanceof ThreadError && error.code === code);
}

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('thread replies stay separate, track unread state and never become nested roots', () => {
  const alice = createUser('thread_alice');
  const bob = createUser('thread_bob');
  const outsider = createUser('thread_outsider');
  const chatId = `chat_${Math.min(alice, bob)}_${Math.max(alice, bob)}`;
  const rootId = insertMessage(chatId, alice, 'Корневое сообщение');
  const firstReply = insertMessage(chatId, bob, 'Первый ответ', rootId);
  insertMessage(chatId, alice, 'Второй ответ', rootId);

  const rootRows = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND thread_root_id IS NULL').all(chatId);
  assert.deepEqual(rootRows.map((row) => row.id), [rootId]);

  const forAlice = getThread(rootId, alice);
  assert.equal(forAlice.replies.length, 2);
  assert.equal(forAlice.summary.reply_count, 2);
  assert.equal(forAlice.summary.unread_count, 1);
  assert.deepEqual(forAlice.summary.recent_authors.map((author) => author.id), [alice, bob]);

  const read = markThreadRead(rootId, alice);
  assert.deepEqual(read.messageIds, [firstReply]);
  assert.equal(read.summary.unread_count, 0);
  assert.equal(db.prepare('SELECT status FROM messages WHERE id = ?').get(firstReply).status, 'read');

  expectThreadError('thread_forbidden', () => getThread(rootId, outsider));
  expectThreadError('thread_not_found', () => rootForUser(firstReply, alice));

  const page = attachThreadSummaries(rootRows, alice);
  assert.equal(page[0].thread.reply_count, 2);
});

test('personal hiding covers future replies and global deletion retains all content', () => {
  const alice = db.prepare("SELECT id FROM users WHERE username = 'thread_alice'").get().id;
  const bob = db.prepare("SELECT id FROM users WHERE username = 'thread_bob'").get().id;
  const chatId = `chat_${Math.min(alice, bob)}_${Math.max(alice, bob)}`;
  const rootId = insertMessage(chatId, alice, 'Корень для удаления');
  const oldReplyId = insertMessage(chatId, bob, 'Старый ответ', rootId);

  hideThread(rootId, bob);
  expectThreadError('thread_not_found', () => getThread(rootId, bob));
  const futureReplyId = insertMessage(chatId, alice, 'Новый ответ после скрытия', rootId);
  expectThreadError('thread_not_found', () => getThread(rootId, bob));

  softDeleteThread(rootId, alice);
  const retained = db.prepare(
    'SELECT id, text, deleted, deleted_at, deleted_by FROM messages WHERE id IN (?, ?, ?) ORDER BY id'
  ).all(rootId, oldReplyId, futureReplyId);
  assert.equal(retained.length, 3);
  assert.deepEqual(retained.map((row) => row.text), [
    'Корень для удаления', 'Старый ответ', 'Новый ответ после скрытия',
  ]);
  assert.ok(retained.every((row) => row.deleted === 1 && row.deleted_at && row.deleted_by === alice));
});

test('thread inbox contains only accessible discussions the user participated in', () => {
  const alice = db.prepare("SELECT id FROM users WHERE username = 'thread_alice'").get().id;
  const bob = db.prepare("SELECT id FROM users WHERE username = 'thread_bob'").get().id;
  const chatId = `chat_${Math.min(alice, bob)}_${Math.max(alice, bob)}`;
  const authoredRoot = insertMessage(chatId, alice, 'Ветка автора');
  insertMessage(chatId, bob, 'Ответ автору', authoredRoot);
  const joinedRoot = insertMessage(chatId, bob, 'Ветка собеседника');
  insertMessage(chatId, alice, 'Участие пользователя', joinedRoot);
  const untouchedRoot = insertMessage(chatId, bob, 'Чужая ветка');
  insertMessage(chatId, bob, 'Ответ без участия пользователя', untouchedRoot);

  const inbox = listThreadsForUser(alice);
  assert.deepEqual(inbox.slice(0, 2).map((item) => item.root_id), [joinedRoot, authoredRoot]);
  assert.ok(!inbox.some((item) => item.root_id === untouchedRoot));
  assert.equal(inbox[0].chat.kind, 'personal');
  assert.equal(inbox[0].chat.name, 'thread_bob');
  assert.equal(inbox[0].summary.reply_count, 1);

  hideThread(joinedRoot, alice);
  assert.ok(!listThreadsForUser(alice).some((item) => item.root_id === joinedRoot));

  // «Ветки» — это общий список участия, а не молча обрезанные первые 100
  // элементов. Явный limit оставляем для служебных/старых клиентов.
  for (let index = 0; index < 101; index += 1) {
    const rootId = insertMessage(chatId, alice, `Массовая ветка ${index}`);
    insertMessage(chatId, bob, `Ответ ${index}`, rootId);
  }
  assert.ok(listThreadsForUser(alice).length > 100);
  assert.equal(listThreadsForUser(alice, 25).length, 25);
});
