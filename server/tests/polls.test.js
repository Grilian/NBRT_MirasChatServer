const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `miras-polls-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_DB_PATH = dbPath;
process.env.SUPERADMIN_USERNAME = `test_admin_${process.pid}`;
process.env.SUPERADMIN_PASSWORD = 'poll-test-password';

const db = require('../db');
const {
  PollError,
  normalizePollDraft,
  insertPoll,
  serializePoll,
  voteInPoll,
  addPollOption,
  stopPoll,
  closeExpiredPolls,
} = require('../services/polls');

function expectPollError(code, action) {
  assert.throws(action, (error) => error instanceof PollError && error.code === code);
}

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('poll lifecycle enforces access, votes, participant options and stop', () => {
  const insertUser = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  const alice = Number(insertUser.run('poll_alice', 'x').lastInsertRowid);
  const bob = Number(insertUser.run('poll_bob', 'x').lastInsertRowid);
  const outsider = Number(insertUser.run('poll_outsider', 'x').lastInsertRowid);
  const chatId = `chat_${Math.min(alice, bob)}_${Math.max(alice, bob)}`;
  const messageId = Number(db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)'
  ).run(chatId, alice, 'Куда поедем?').lastInsertRowid);

  const { id: pollId } = insertPoll(messageId, chatId, alice, {
    question: 'Куда поедем?',
    description: 'Выбираем вместе',
    options: ['Москва', 'Казань'],
    showVoterNames: true,
    multipleChoice: false,
    allowAddOptions: true,
    allowChangeVote: true,
  });

  const initial = serializePoll(pollId, bob);
  assert.equal(initial.options.length, 2);
  assert.equal(initial.can_add_option, true);
  expectPollError('poll_forbidden', () => serializePoll(pollId, outsider));

  voteInPoll(pollId, bob, [initial.options[0].id]);
  let visible = serializePoll(pollId, alice);
  assert.equal(visible.total_voters, 1);
  assert.equal(visible.options[0].vote_count, 1);
  assert.equal(visible.options[0].voters[0].id, bob);

  voteInPoll(pollId, bob, [initial.options[1].id]);
  visible = serializePoll(pollId, bob);
  assert.deepEqual(visible.user_option_ids, [initial.options[1].id]);
  assert.equal(visible.options[0].vote_count, 0);
  assert.equal(visible.options[1].vote_count, 1);

  expectPollError('duplicate_option', () => addPollOption(pollId, bob, 'МОСКВА'));
  for (let index = 3; index <= 12; index += 1) addPollOption(pollId, bob, `Вариант ${index}`);
  visible = serializePoll(pollId, alice);
  assert.equal(visible.options.length, 12);
  assert.equal(visible.can_add_option, false);
  expectPollError('option_limit', () => addPollOption(pollId, bob, 'Лишний'));

  expectPollError('stop_forbidden', () => stopPoll(pollId, bob));
  stopPoll(pollId, alice);
  assert.ok(serializePoll(pollId, bob).closed_at);
  expectPollError('poll_closed', () => voteInPoll(pollId, bob, [initial.options[0].id]));
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
  expectPollError('poll_not_found', () => serializePoll(pollId, bob));
});

test('anonymous and multiple-choice modes do not leak voter identities', () => {
  const users = db.prepare("SELECT id FROM users WHERE username IN ('poll_alice', 'poll_bob') ORDER BY username").all();
  const alice = Number(users[0].id);
  const bob = Number(users[1].id);
  const messageId = Number(db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text) VALUES ('general', ?, 'Что взять?')"
  ).run(alice).lastInsertRowid);
  const { id: pollId } = insertPoll(messageId, 'general', alice, {
    question: 'Что взять?',
    options: ['Чай', 'Кофе'],
    showVoterNames: false,
    multipleChoice: true,
    allowChangeVote: false,
  });
  const options = serializePoll(pollId, bob).options;
  voteInPoll(pollId, bob, options.map((option) => option.id));

  const result = serializePoll(pollId, alice);
  assert.equal(result.total_voters, 1);
  assert.equal(result.options[0].percentage, 100);
  assert.equal(result.options[1].percentage, 100);
  assert.equal('voters' in result.options[0], false);
  expectPollError('vote_locked', () => voteInPoll(pollId, bob, [options[0].id]));
});

test('expired poll is closed and broadcast by the deadline sweep', () => {
  const alice = Number(db.prepare("SELECT id FROM users WHERE username = 'poll_alice'").get().id);
  const messageId = Number(db.prepare(
    "INSERT INTO messages (chat_id, sender_id, text) VALUES ('general', ?, 'Срочный вопрос')"
  ).run(alice).lastInsertRowid);
  const { id: pollId } = insertPoll(messageId, 'general', alice, {
    question: 'Срочный вопрос', options: ['Да', 'Нет'], closesAt: Date.now() + 120_000,
  });
  db.prepare('UPDATE polls SET closes_at = ? WHERE id = ?').run(Date.now() - 1, pollId);

  const emitted = [];
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  assert.equal(closeExpiredPolls(io), 1);
  assert.ok(serializePoll(pollId, alice).closed_at);
  assert.ok(emitted.some((item) => item.event === 'poll_updated' && item.payload.poll.closed_at));
  assert.equal(closeExpiredPolls(io), 0);
});

test('draft validation rejects empty and duplicate options', () => {
  expectPollError('question_required', () => normalizePollDraft({ question: '', options: ['Да', 'Нет'] }));
  expectPollError('duplicate_option', () => normalizePollDraft({ question: 'Вопрос', options: ['Да', 'ДА'] }));
  expectPollError('options_required', () => normalizePollDraft({ question: 'Вопрос', options: ['Да'] }));
});
