// Слой сокета: отправка, правка, удаление, реакции, прочтение.
//
// До 07.09.2026 он не был покрыт НИ ОДНИМ тестом, при том что вся живая часть
// мессенджера живёт именно здесь: серверные тесты ходят по HTTP и до сокета не
// доходят. Обнаружилось это неприятным способом — обработчики переехали в
// отдельные модули со сломанным `require`, сервер не поднимался, а `npm test`
// показал 118 из 118.
//
// Обработчики зарегистрированы как `register(socket, ctx)`, поэтому проверять
// их можно напрямую: поддельный сокет, поддельный контекст, вызов обработчика
// по имени события. Настоящий socket.io для этого поднимать незачем — он не
// добавил бы к проверке ничего, кроме времени.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcryptjs');

process.env.MIRAS_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-socket-uploads-'));
process.env.MIRAS_DB_PATH = path.join(os.tmpdir(), `miras-socket-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = 'socket-test-secret';
process.env.SUPERADMIN_USERNAME = `socket_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'socket-test-password';

const db = require('../db');
const messagesHandler = require('../socket/handlers/messages');
const reactionsHandler = require('../socket/handlers/reactions');
const readsHandler = require('../socket/handlers/reads');
const typingHandler = require('../socket/handlers/typing');
const presenceHandler = require('../socket/handlers/presence');

// ---------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------

/** Всё, что слой отправил наружу: [куда, событие, полезная нагрузка]. */
let sent = [];

function makeCtx() {
  return {
    io: {
      emit: (event, payload) => sent.push(['все', event, payload]),
      to: (room) => ({ emit: (event, payload) => sent.push([room, event, payload]) }),
    },
    emitToChat: (chatId, event, payload) => sent.push([chatId, event, payload]),
    broadcastToChat: (_socket, chatId, event, payload) => sent.push([chatId, event, payload]),
    markPendingDelivered: () => {},
  };
}

function makeSocket(userId) {
  const listeners = {};
  const socket = {
    id: `sock_${userId}_${Math.random().toString(36).slice(2)}`,
    userId,
    handshake: { headers: {}, address: '10.0.0.1' },
    on(event, fn) { (listeners[event] || (listeners[event] = [])).push(fn); },
    join() {},
    emit: (event, payload) => sent.push([`сокет:${userId}`, event, payload]),
    to: () => ({ emit: (event, payload) => sent.push(['комната', event, payload]) }),
    broadcast: { emit: (event, payload) => sent.push(['все, кроме себя', event, payload]) },
    /** Вызвать обработчик события и дождаться его, если он асинхронный. */
    async fire(event, ...args) {
      for (const fn of listeners[event] || []) await fn(...args);
    },
    listens: (event) => !!(listeners[event] && listeners[event].length),
  };
  const ctx = makeCtx();
  for (const handler of [presenceHandler, messagesHandler, reactionsHandler, readsHandler, typingHandler]) {
    handler.register(socket, ctx);
  }
  return socket;
}

/** Отправить сообщение и получить подтверждение, как его видит клиент. */
async function send(socket, payload) {
  let ack = null;
  await socket.fire('chat_message', payload, (response) => { ack = response; });
  return ack;
}

let nextUser = 0;
function createUser(tag) {
  nextUser += 1;
  const username = `sock_${tag}_${nextUser}`;
  const id = Number(db.prepare(
    'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
  ).run(username, bcrypt.hashSync('x', 4), tag).lastInsertRowid);
  return id;
}

function privateChat(a, b) {
  return `chat_${Math.min(a, b)}_${Math.max(a, b)}`;
}

test.beforeEach(() => { sent = []; });

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------

test('сообщение сохраняется и уходит участникам чата', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);

  const ack = await send(makeSocket(a), { chatId, text: 'привет' });

  assert.equal(ack.ok, true);
  const row = db.prepare('SELECT text, sender_id, chat_id FROM messages WHERE id = ?').get(ack.messageId);
  assert.deepEqual(row, { text: 'привет', sender_id: a, chat_id: chatId });
  assert.ok(sent.some(([to, event]) => to === chatId && event === 'chat_message'));
});

test('отправитель берётся из сокета, а не из того, что прислал клиент', async () => {
  // Раньше senderId приходил полем от клиента, и подделать его было тривиально.
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);

  const ack = await send(makeSocket(a), { chatId, text: 'от чужого имени', senderId: b });

  assert.equal(db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(ack.messageId).sender_id, a);
});

test('в чужой личный чат написать нельзя, даже зная его идентификатор', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const c = createUser('c');

  const ack = await send(makeSocket(c), { chatId: privateChat(a, b), text: 'подслушиваю' });

  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'chat_forbidden');
});

test('неавторизованный сокет не пишет ничего', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const socket = makeSocket(a);
  socket.userId = undefined; // 'user_online' не проходил

  const ack = await send(socket, { chatId: privateChat(a, b), text: 'мимо' });

  assert.equal(ack.error, 'auth_required');
});

test('пустое сообщение не создаёт строку', async () => {
  const a = createUser('a');
  const b = createUser('b');

  const ack = await send(makeSocket(a), { chatId: privateChat(a, b), text: '   ' });

  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'empty_message');
});

test('повтор с тем же ключом подтверждает исходную запись, а не создаёт вторую', async () => {
  // Ключ идемпотентности: потерянное подтверждение заставляет клиента
  // отправить повторно, и без дедупликации в переписке появлялся дубль.
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const socket = makeSocket(a);
  const key = 'abcdefghij1234567890';

  const first = await send(socket, { chatId, text: 'один раз', clientMessageId: key });
  const second = await send(socket, { chatId, text: 'один раз', clientMessageId: key });

  assert.equal(second.messageId, first.messageId);
  assert.equal(second.deduplicated, true);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM messages WHERE sender_id = ? AND client_message_id = ?').get(a, key).c,
    1,
  );
});

// ---------------------------------------------------------------------------
// Удаление и правка
// ---------------------------------------------------------------------------

test('удаление у всех НЕ стирает ни текст, ни файл — только ставит флаг', async () => {
  // Юридическое обязательство: переписку нужно быть готовыми предоставить
  // целиком. Наружу удалённое не отдаётся, но в базе остаётся навсегда.
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const socket = makeSocket(a);
  const ack = await send(socket, { chatId, text: 'секрет' });

  await socket.fire('message_delete', { id: ack.messageId, forEveryone: true });

  const row = db.prepare('SELECT text, deleted FROM messages WHERE id = ?').get(ack.messageId);
  assert.equal(row.deleted, 1, 'флаг должен быть выставлен');
  assert.equal(row.text, 'секрет', 'содержимое обязано остаться в базе');
});

test('чужое сообщение в личной переписке может убрать любой из двоих', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const ack = await send(makeSocket(a), { chatId, text: 'от первого' });

  await makeSocket(b).fire('message_delete', { id: ack.messageId, forEveryone: true });

  assert.equal(db.prepare('SELECT deleted FROM messages WHERE id = ?').get(ack.messageId).deleted, 1);
});

test('правка меняет текст и рассылается участникам', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const socket = makeSocket(a);
  const ack = await send(socket, { chatId, text: 'было' });
  sent = [];

  await socket.fire('message_edit', { id: ack.messageId, text: 'стало' });

  assert.equal(db.prepare('SELECT text FROM messages WHERE id = ?').get(ack.messageId).text, 'стало');
  assert.ok(sent.some(([to, event]) => to === chatId && event === 'message_edited'));
});

test('чужое сообщение править нельзя', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const ack = await send(makeSocket(a), { chatId, text: 'моё' });

  await makeSocket(b).fire('message_edit', { id: ack.messageId, text: 'переписал' });

  assert.equal(db.prepare('SELECT text FROM messages WHERE id = ?').get(ack.messageId).text, 'моё');
});

// ---------------------------------------------------------------------------
// Реакции
// ---------------------------------------------------------------------------

test('у человека под сообщением ровно одна реакция — повторная заменяет прежнюю', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const ack = await send(makeSocket(a), { chatId, text: 'оценят' });
  const socket = makeSocket(b);

  await socket.fire('reaction_set', { messageId: ack.messageId, chatId, emoji: '👍' });
  await socket.fire('reaction_set', { messageId: ack.messageId, chatId, emoji: '❤️' });

  const rows = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?')
    .all(ack.messageId, b);
  assert.deepEqual(rows.map((r) => r.emoji), ['❤️']);
});

test('повторное нажатие по своей же реакции снимает её', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const ack = await send(makeSocket(a), { chatId, text: 'передумают' });
  const socket = makeSocket(b);

  await socket.fire('reaction_set', { messageId: ack.messageId, chatId, emoji: '👍' });
  await socket.fire('reaction_set', { messageId: ack.messageId, chatId, emoji: '👍' });

  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM message_reactions WHERE message_id = ?').get(ack.messageId).c,
    0,
  );
});

// ---------------------------------------------------------------------------
// Прочтение
// ---------------------------------------------------------------------------

test('отметка прочтения меняет статус и сообщает отправителю', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const ack = await send(makeSocket(a), { chatId, text: 'прочти' });
  sent = [];

  await makeSocket(b).fire('message_read', { chatId, messageIds: [ack.messageId] });

  assert.equal(db.prepare('SELECT status FROM messages WHERE id = ?').get(ack.messageId).status, 'read');
  assert.ok(sent.some(([, event]) => event === 'message_status_bulk' || event === 'message_status'));
});

test('своё сообщение прочитанным себе не отмечается', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);
  const socket = makeSocket(a);
  const ack = await send(socket, { chatId, text: 'сам себе' });

  await socket.fire('message_read', { chatId, messageIds: [ack.messageId] });

  assert.notEqual(db.prepare('SELECT status FROM messages WHERE id = ?').get(ack.messageId).status, 'read');
});

// ---------------------------------------------------------------------------
// Печатает…
// ---------------------------------------------------------------------------

test('индикатор набора уходит остальным участникам, но не самому себе', async () => {
  const a = createUser('a');
  const b = createUser('b');
  const chatId = privateChat(a, b);

  await makeSocket(a).fire('typing', { chatId });

  const typing = sent.filter(([, event]) => event === 'typing');
  assert.equal(typing.length, 1);
  assert.equal(typing[0][0], chatId);
});

// ---------------------------------------------------------------------------
// Состав слоя
// ---------------------------------------------------------------------------

test('все события, на которые рассчитывает клиент, имеют обработчик', () => {
  // Дешёвая страховка от потери подписки при переезде кода: клиент шлёт эти
  // события и молча не получит ничего, если обработчик исчезнет.
  const socket = makeSocket(createUser('a'));
  for (const event of [
    'user_online', 'chat_message', 'message_edit', 'message_delete',
    'message_read', 'message_delivered', 'mark_chat_read', 'mark_all_read',
    'reaction_set', 'reaction_remove', 'typing', 'stop_typing',
    'app_state', 'message_notified', 'disconnect',
  ]) {
    assert.ok(socket.listens(event), `нет обработчика '${event}'`);
  }
});

// ---------------------------------------------------------------------------
// Расположение базы
// ---------------------------------------------------------------------------

test('база по умолчанию лежит в корне server, а не рядом с модулем схемы', () => {
  // Стоило отдельной поломки: при разборе db.js на шаги файл подключения
  // переехал в server/db/, а путь остался «рядом со мной» — сервер молча
  // завёл ПУСТУЮ базу в server/db/messenger.db и поднялся на ней. Приложение
  // выглядело так, будто все данные исчезли.
  //
  // Ни один тест этого не увидел: все они задают MIRAS_DB_PATH и до значения
  // по умолчанию не доходят. Поэтому проверяем именно ветку умолчания —
  // читая исходник, а не открывая базу.
  const source = fs.readFileSync(path.join(__dirname, '..', 'db', 'connection.js'), 'utf8');
  const fallback = /MIRAS_DB_PATH[\s\S]*?:\s*path\.join\(([^)]*)\)/.exec(source);
  assert.ok(fallback, 'не нашли ветку пути по умолчанию');
  assert.match(
    fallback[1],
    /__dirname,\s*'\.\.'/,
    'путь по умолчанию обязан подниматься из db/ в корень server/',
  );
});
