const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `miras-traces-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-traces-uploads-'));
process.env.MIRAS_DB_PATH = dbPath;
process.env.SUPERADMIN_USERNAME = `traces_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'traces-test-password';

const db = require('../db');
const {
  countsForMessages,
  hasTrace,
  removeTrace,
  resolveOrigin,
  setTrace,
  traceCount,
} = require('../services/traces');
const { archiveAndDeleteUser } = require('../services/accountArchive');

let seq = 0;
const createUser = (name) => Number(db.prepare(
  'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
).run(`${name}_${seq += 1}`, 'x', name).lastInsertRowid);

const insert = (chatId, senderId, text, origin = null, via = null) => Number(db.prepare(
  'INSERT INTO messages (chat_id, sender_id, text, origin_message_id, origin_via) VALUES (?, ?, ?, ?, ?)'
).run(chatId, senderId, text, origin, via).lastInsertRowid);

/** Пересылка так, как её записывает сервер: цепочка схлопывается при записи. */
const forward = (chatId, senderId, sourceId, via = 'forward') => {
  const source = db.prepare('SELECT id, origin_message_id FROM messages WHERE id = ?').get(sourceId);
  return insert(chatId, senderId, 'копия', source.origin_message_id || source.id, via);
};

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(process.env.MIRAS_UPLOADS_DIR, { recursive: true, force: true });
});

test('след ложится на первоисточник, а не на копию', () => {
  // Главное правило механики: След принадлежит не копии сообщения, а его
  // исходному объекту. Наследить можно на что угодно из цепочки — запись
  // обязана оказаться на том сообщении, с которого всё началось.
  const author = createUser('author');
  const reader = createUser('reader');
  const originId = insert('general', author, 'исходное');
  const copyId = forward(`chat_${author}_${reader}`, author, originId);

  const origin = resolveOrigin(copyId);
  assert.equal(origin.id, originId);
  assert.equal(origin.chat_id, 'general');

  setTrace(origin.id, origin.chat_id, reader, null);
  assert.equal(traceCount(originId), 1);
  assert.equal(traceCount(copyId), 0, 'след осел на копии — цепочка происхождения порвана');
});

test('пересылка пересланного не переписывает первоисточник', () => {
  const a = createUser('chain_a');
  const b = createUser('chain_b');
  const originId = insert('general', a, 'начало');
  const first = forward(`chat_${a}_${b}`, a, originId);
  const second = forward(`chat_${b}_${a}`, b, first);

  assert.equal(resolveOrigin(second).id, originId, 'origin переписался на промежуточную копию');
});

test('следы и пересылки считаются раздельно', () => {
  // Две независимые механики: лапка показывает Следы, стрелка — обычные
  // пересылки. Смешать их означало бы показать человеку цифру, которая не
  // отвечает ни на один вопрос.
  const author = createUser('counts_author');
  const one = createUser('counts_one');
  const two = createUser('counts_two');
  const originId = insert('general', author, 'полезное');

  forward(`chat_${author}_${one}`, author, originId);
  forward(`chat_${author}_${two}`, author, originId);
  // Передача из Следов — не обычная пересылка и в счётчик пересылок не идёт.
  forward(`chat_${one}_${two}`, one, originId, 'trace');

  setTrace(originId, 'general', one, null);
  setTrace(originId, 'general', two, null);

  const counts = countsForMessages([originId], one);
  assert.equal(counts[originId].traces, 2);
  assert.equal(counts[originId].forwards, 2, 'передача следа попала в счётчик пересылок');
  assert.equal(counts[originId].traced, true);

  assert.equal(countsForMessages([originId], author)[originId].traced, false,
    'чужой след показан как свой');
});

test('повторное «Наследить» не плодит строк, а обновляет заметку', () => {
  const author = createUser('note_author');
  const reader = createUser('note_reader');
  const originId = insert('general', author, 'к чему вернуться');

  setTrace(originId, 'general', reader, 'первая заметка');
  setTrace(originId, 'general', reader, 'вернуться после рефакторинга');

  assert.equal(traceCount(originId), 1);
  const row = db.prepare('SELECT note FROM message_traces WHERE origin_message_id = ? AND user_id = ?')
    .get(originId, reader);
  assert.equal(row.note, 'вернуться после рефакторинга');
});

test('заметка обрезается и пустая не хранится', () => {
  const author = createUser('long_author');
  const reader = createUser('long_reader');
  const originId = insert('general', author, 'длинное');

  setTrace(originId, 'general', reader, 'я'.repeat(900));
  assert.equal(
    db.prepare('SELECT LENGTH(note) AS n FROM message_traces WHERE origin_message_id = ?').get(originId).n,
    500,
  );

  setTrace(originId, 'general', reader, '   ');
  assert.equal(
    db.prepare('SELECT note FROM message_traces WHERE origin_message_id = ?').get(originId).note,
    null,
  );
});

test('след переживает мягкое удаление источника — он и есть «подчищенный»', () => {
  const author = createUser('soft_author');
  const reader = createUser('soft_reader');
  const originId = insert('general', author, 'скоро удалят');
  setTrace(originId, 'general', reader, null);

  db.prepare('UPDATE messages SET deleted = 1, text = ? WHERE id = ?').run('', originId);

  assert.equal(hasTrace(originId, reader), true, 'след исчез вместе с содержимым источника');
  assert.equal(traceCount(originId), 1);
});

test('след переживает физическое исчезновение источника', () => {
  // Удаление аккаунта стирает сообщения личных переписок строками, а не
  // флагом. С внешним ключом ON DELETE CASCADE след молча исчез бы вместо
  // того, чтобы показать «след подчищен».
  const owner = createUser('gone_owner');
  const peer = createUser('gone_peer');
  const watcher = createUser('gone_watcher');
  const chatId = `chat_${owner}_${peer}`;
  const originId = insert(chatId, owner, 'исчезнет целиком');
  setTrace(originId, chatId, watcher, 'зачем-то нужно');

  db.prepare('DELETE FROM messages WHERE id = ?').run(originId);

  assert.equal(hasTrace(originId, watcher), true, 'след пропал вместе со строкой источника');
  assert.equal(db.prepare('SELECT origin_chat_id FROM message_traces WHERE origin_message_id = ?')
    .get(originId).origin_chat_id, chatId, 'потеряно даже то, ГДЕ это было');
});

test('удаление аккаунта уносит его собственные следы и не трогает чужие', () => {
  const leaving = createUser('leaving');
  const staying = createUser('staying');
  const originId = insert('general', staying, 'общее сообщение');
  const leavingOwn = insert('general', leaving, 'его сообщение');

  setTrace(originId, 'general', leaving, null);
  setTrace(leavingOwn, 'general', staying, null);

  archiveAndDeleteUser(leaving);

  assert.equal(hasTrace(originId, leaving), false, 'следы уходящего остались висеть');
  assert.equal(hasTrace(leavingOwn, staying), true,
    'вместе с аккаунтом снесли чужой след — он должен был стать подчищенным, а не исчезнуть');
});

test('снять можно и подчищенный след', () => {
  const author = createUser('remove_author');
  const reader = createUser('remove_reader');
  const originId = insert('general', author, 'удалят');
  setTrace(originId, 'general', reader, null);
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(originId);

  removeTrace(originId, reader);
  assert.equal(hasTrace(originId, reader), false);
});
