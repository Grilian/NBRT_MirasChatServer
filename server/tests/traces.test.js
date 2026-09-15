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

// ===== Список раздела: четыре состояния следа =====

const { listTraces } = require('../services/traces');

test('живой след отдаёт содержимое, подчищенный — нет', () => {
  const author = createUser('list_author');
  const reader = createUser('list_reader');
  const aliveId = insert('general', author, 'живое сообщение');
  const goneId = insert('general', author, 'секрет, который удалят');
  setTrace(aliveId, 'general', reader, null);
  setTrace(goneId, 'general', reader, null);

  db.prepare('UPDATE messages SET deleted = 1, deleted_by = ? WHERE id = ?').run(author, goneId);

  const items = listTraces(reader);
  const alive = items.find((i) => i.origin_message_id === aliveId);
  const gone = items.find((i) => i.origin_message_id === goneId);

  assert.equal(alive.state, 'ok');
  assert.equal(alive.text, 'живое сообщение');
  assert.equal(alive.chat.name, 'Общий чат');

  assert.equal(gone.state, 'cleaned');
  assert.equal(gone.text, undefined, 'текст удалённого утёк через список Следов');
  assert.ok(gone.deleted_by_name, 'кто подчистил — известно, но не показано');
});

test('скрытое у себя — отдельное состояние, а не «удалено»', () => {
  // У остальных сообщение живо, и называть это удалением значило бы соврать.
  const author = createUser('hidden_author');
  const reader = createUser('hidden_reader');
  const messageId = insert('general', author, 'скрою у себя');
  setTrace(messageId, 'general', reader, null);
  db.prepare('INSERT INTO message_hidden (message_id, user_id, hidden_at) VALUES (?, ?, ?)').run(messageId, reader, Date.now());

  const item = listTraces(reader).find((i) => i.origin_message_id === messageId);
  assert.equal(item.state, 'hidden');
  assert.equal(item.text, undefined);
});

test('чужое скрытие на мой след не влияет', () => {
  const author = createUser('other_hidden_author');
  const reader = createUser('other_hidden_reader');
  const messageId = insert('general', author, 'кто-то другой скрыл это у себя');
  setTrace(messageId, 'general', reader, null);
  db.prepare('INSERT INTO message_hidden (message_id, user_id, hidden_at) VALUES (?, ?, ?)').run(messageId, author, Date.now());

  const item = listTraces(reader).find((i) => i.origin_message_id === messageId);
  assert.equal(item.state, 'ok');
});

test('потеря доступа к исходному месту закрывает содержимое, но не сам след', () => {
  const a = createUser('access_a');
  const b = createUser('access_b');
  const outsider = createUser('access_outsider');
  const chatId = `chat_${Math.min(a, b)}_${Math.max(a, b)}`;
  const messageId = insert(chatId, a, 'переписка двоих');
  // След у постороннего мог появиться законно — через переданный след.
  setTrace(messageId, chatId, outsider, 'зачем-то сохранил');

  const item = listTraces(outsider).find((i) => i.origin_message_id === messageId);
  assert.equal(item.state, 'forbidden');
  assert.equal(item.text, undefined, 'содержимое закрытого чата утекло в список');
  assert.equal(item.note, 'зачем-то сохранил', 'своя заметка принадлежит человеку и остаётся');
});

test('фильтры разбирают следы по виду содержимого и по заметкам', () => {
  const author = createUser('kind_author');
  const reader = createUser('kind_reader');
  const plain = insert('general', author, 'просто текст');
  const link = insert('general', author, 'смотри https://example.org/doc');
  const image = Number(db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text, file_path) VALUES ('general', ?, '', '/uploads/users/1/images/a.webp')"
  ).run(author).lastInsertRowid);

  setTrace(plain, 'general', reader, 'вернуться позже');
  setTrace(link, 'general', reader, null);
  setTrace(image, 'general', reader, null);

  const ids = (kind) => listTraces(reader, { kind }).map((i) => i.origin_message_id);
  assert.deepEqual(ids('links'), [link]);
  assert.deepEqual(ids('images'), [image]);
  assert.deepEqual(ids('messages'), [plain]);
  assert.deepEqual(ids('notes'), [plain]);
  assert.equal(ids('all').length, 3);
});
