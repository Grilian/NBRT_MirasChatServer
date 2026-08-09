const db = require('../db');
const { isParticipant, participantsForChatId } = require('./chatParticipants');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;
const MAX_QUESTION_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_OPTION_LENGTH = 100;
const MAX_POLL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

class PollError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function asFlag(value, fallback) {
  return value === undefined ? fallback : !!value;
}

function normalizePollDraft(raw) {
  if (!raw || typeof raw !== 'object') throw new PollError('invalid_poll', 'Некорректные данные опроса');

  const question = cleanText(raw.question, MAX_QUESTION_LENGTH);
  const description = cleanText(raw.description, MAX_DESCRIPTION_LENGTH);
  if (!question) throw new PollError('question_required', 'Введите вопрос');

  const options = Array.isArray(raw.options)
    ? raw.options.map((option) => cleanText(option, MAX_OPTION_LENGTH)).filter(Boolean)
    : [];
  if (options.length < MIN_OPTIONS) throw new PollError('options_required', 'Добавьте минимум два варианта ответа');
  if (options.length > MAX_OPTIONS) throw new PollError('too_many_options', `Можно добавить не больше ${MAX_OPTIONS} вариантов`);

  const normalized = new Set(options.map((option) => option.toLocaleLowerCase('ru-RU')));
  if (normalized.size !== options.length) throw new PollError('duplicate_option', 'Варианты ответа не должны повторяться');

  const now = Date.now();
  let closesAt = raw.closesAt == null ? null : Number(raw.closesAt);
  if (closesAt !== null) {
    if (!Number.isFinite(closesAt) || closesAt < now + 60 * 1000) {
      throw new PollError('invalid_deadline', 'Срок опроса должен быть хотя бы через минуту');
    }
    closesAt = Math.min(Math.trunc(closesAt), now + MAX_POLL_LIFETIME_MS);
  }

  return {
    question,
    description: description || null,
    options,
    showVoterNames: asFlag(raw.showVoterNames, true),
    multipleChoice: asFlag(raw.multipleChoice, false),
    allowAddOptions: asFlag(raw.allowAddOptions, false),
    allowChangeVote: asFlag(raw.allowChangeVote, true),
    closesAt,
  };
}

function pollRow(pollId) {
  return db.prepare(`
    SELECT p.*, COALESCE(m.deleted, 0) AS message_deleted
    FROM polls p
    JOIN messages m ON m.id = p.message_id
    WHERE p.id = ?
  `).get(Number(pollId));
}

function closeIfExpired(row) {
  if (!row || row.closed_at || !row.closes_at || row.closes_at > Date.now()) return row;
  db.prepare('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(row.closes_at, row.id);
  return { ...row, closed_at: row.closes_at };
}

function ensureAccessible(row, userId) {
  if (!row) throw new PollError('poll_not_found', 'Опрос не найден');
  if (row.message_deleted) throw new PollError('poll_not_found', 'Опрос больше недоступен');
  if (!isParticipant(row.chat_id, userId)) throw new PollError('poll_forbidden', 'Нет доступа к этому опросу');
}

function serializePoll(pollId, userId) {
  const row = closeIfExpired(pollRow(pollId));
  ensureAccessible(row, userId);

  const options = db.prepare(`
    SELECT o.id, o.text, o.position, o.created_by, o.created_at, COUNT(v.user_id) AS vote_count
    FROM poll_options o
    LEFT JOIN poll_votes v ON v.option_id = o.id AND v.poll_id = o.poll_id
    WHERE o.poll_id = ?
    GROUP BY o.id
    ORDER BY o.position, o.id
  `).all(row.id);
  const totalVoters = db.prepare('SELECT COUNT(DISTINCT user_id) AS count FROM poll_votes WHERE poll_id = ?').get(row.id).count;
  const ownOptionIds = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ? ORDER BY option_id')
    .all(row.id, Number(userId)).map((vote) => vote.option_id);

  const votersByOption = {};
  if (row.show_voter_names) {
    const voters = db.prepare(`
      SELECT v.option_id, v.created_at, u.id, u.username, u.display_name, u.avatar_path
      FROM poll_votes v
      JOIN users u ON u.id = v.user_id
      WHERE v.poll_id = ?
      ORDER BY v.created_at, u.id
    `).all(row.id);
    for (const voter of voters) {
      if (!votersByOption[voter.option_id]) votersByOption[voter.option_id] = [];
      votersByOption[voter.option_id].push({
        id: voter.id,
        username: voter.username,
        display_name: voter.display_name,
        avatar_path: voter.avatar_path,
        voted_at: voter.created_at,
      });
    }
  }

  const maxVotes = options.reduce((max, option) => Math.max(max, Number(option.vote_count)), 0);
  const closed = !!row.closed_at;
  return {
    id: row.id,
    message_id: row.message_id,
    chat_id: row.chat_id,
    creator_id: row.creator_id,
    question: row.question,
    description: row.description,
    show_voter_names: !!row.show_voter_names,
    multiple_choice: !!row.multiple_choice,
    allow_add_options: !!row.allow_add_options,
    allow_change_vote: !!row.allow_change_vote,
    closes_at: row.closes_at,
    closed_at: row.closed_at,
    created_at: row.created_at,
    total_voters: Number(totalVoters),
    user_option_ids: ownOptionIds,
    has_voted: ownOptionIds.length > 0,
    can_add_option: !closed && !!row.allow_add_options && options.length < MAX_OPTIONS,
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
      position: option.position,
      created_by: option.created_by,
      vote_count: Number(option.vote_count),
      percentage: totalVoters ? Math.round((Number(option.vote_count) / Number(totalVoters)) * 100) : 0,
      is_winner: closed && maxVotes > 0 && Number(option.vote_count) === maxVotes,
      ...(row.show_voter_names ? { voters: votersByOption[option.id] || [] } : {}),
    })),
  };
}

function attachPollsToMessages(messages, userId) {
  if (!messages.length) return messages;
  const placeholders = messages.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, message_id FROM polls WHERE message_id IN (${placeholders})`)
    .all(...messages.map((message) => message.id));
  const byMessage = new Map(rows.map((row) => [row.message_id, row.id]));
  for (const message of messages) {
    const pollId = byMessage.get(message.id);
    if (pollId && !message.deleted) message.poll = serializePoll(pollId, userId);
  }
  return messages;
}

function insertPoll(messageId, chatId, creatorId, rawDraft) {
  const draft = normalizePollDraft(rawDraft);
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO polls
      (message_id, chat_id, creator_id, question, description, show_voter_names,
       multiple_choice, allow_add_options, allow_change_vote, closes_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(messageId), String(chatId), Number(creatorId), draft.question, draft.description,
    draft.showVoterNames ? 1 : 0, draft.multipleChoice ? 1 : 0,
    draft.allowAddOptions ? 1 : 0, draft.allowChangeVote ? 1 : 0, draft.closesAt, now,
  );
  const insertOption = db.prepare(`
    INSERT INTO poll_options (poll_id, text, position, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  draft.options.forEach((option, index) => insertOption.run(result.lastInsertRowid, option, index, creatorId, now));
  return { id: Number(result.lastInsertRowid), draft };
}

const voteInPoll = db.transaction((pollId, userId, rawOptionIds) => {
  const row = closeIfExpired(pollRow(pollId));
  ensureAccessible(row, userId);
  if (row.closed_at) throw new PollError('poll_closed', 'Опрос уже завершён');

  const optionIds = Array.from(new Set((Array.isArray(rawOptionIds) ? rawOptionIds : [])
    .map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (!optionIds.length) throw new PollError('vote_required', 'Выберите вариант ответа');
  if (!row.multiple_choice && optionIds.length !== 1) throw new PollError('single_choice', 'Можно выбрать только один вариант');

  const placeholders = optionIds.map(() => '?').join(',');
  const validCount = db.prepare(`SELECT COUNT(*) AS count FROM poll_options WHERE poll_id = ? AND id IN (${placeholders})`)
    .get(row.id, ...optionIds).count;
  if (Number(validCount) !== optionIds.length) throw new PollError('invalid_option', 'Один из вариантов больше недоступен');

  const existing = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(row.id, userId);
  if (existing.length && !row.allow_change_vote) throw new PollError('vote_locked', 'Автор запретил изменять ответ');

  db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(row.id, userId);
  const insert = db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  optionIds.forEach((optionId) => insert.run(row.id, optionId, Number(userId), now));
  return row.id;
});

const addPollOption = db.transaction((pollId, userId, rawText) => {
  const row = closeIfExpired(pollRow(pollId));
  ensureAccessible(row, userId);
  if (row.closed_at) throw new PollError('poll_closed', 'Опрос уже завершён');
  if (!row.allow_add_options) throw new PollError('adding_disabled', 'Автор запретил добавлять варианты');

  const text = cleanText(rawText, MAX_OPTION_LENGTH);
  if (!text) throw new PollError('option_required', 'Введите вариант ответа');
  const current = db.prepare('SELECT COUNT(*) AS count FROM poll_options WHERE poll_id = ?').get(row.id).count;
  if (Number(current) >= MAX_OPTIONS) throw new PollError('option_limit', `Достигнут лимит — ${MAX_OPTIONS} вариантов`);
  // SQLite без ICU корректно LOWER-ит только ASCII. Сравниваем в JS, чтобы
  // «Москва» и «МОСКВА» также считались одним вариантом.
  const normalizedText = text.toLocaleLowerCase('ru-RU');
  const duplicate = db.prepare('SELECT text FROM poll_options WHERE poll_id = ?').all(row.id)
    .some((option) => option.text.toLocaleLowerCase('ru-RU') === normalizedText);
  if (duplicate) throw new PollError('duplicate_option', 'Такой вариант уже есть');

  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM poll_options WHERE poll_id = ?').get(row.id).position;
  db.prepare(`INSERT INTO poll_options (poll_id, text, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, text, position, Number(userId), Date.now());
  return row.id;
});

const stopPoll = db.transaction((pollId, userId) => {
  const row = closeIfExpired(pollRow(pollId));
  ensureAccessible(row, userId);
  if (Number(row.creator_id) !== Number(userId)) throw new PollError('stop_forbidden', 'Остановить опрос может только создатель');
  if (row.closed_at) throw new PollError('poll_closed', 'Опрос уже завершён');
  db.prepare('UPDATE polls SET closed_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row.id;
});

function emitPollUpdate(io, pollId) {
  const row = pollRow(pollId);
  if (!row || row.message_deleted) return;
  const participants = participantsForChatId(row.chat_id);
  const userIds = participants === null
    ? db.prepare('SELECT id FROM users').all().map((user) => user.id)
    : participants;
  for (const userId of userIds) {
    io.to(`user:${userId}`).emit('poll_updated', {
      message_id: row.message_id,
      poll: serializePoll(row.id, userId),
    });
  }
}

function closeExpiredPolls(io) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT p.id FROM polls p
    JOIN messages m ON m.id = p.message_id
    WHERE p.closed_at IS NULL AND p.closes_at IS NOT NULL AND p.closes_at <= ?
      AND COALESCE(m.deleted, 0) = 0
  `).all(now);
  if (!rows.length) return 0;

  const close = db.prepare('UPDATE polls SET closed_at = closes_at WHERE id = ? AND closed_at IS NULL');
  for (const row of rows) {
    if (close.run(row.id).changes) emitPollUpdate(io, row.id);
  }
  return rows.length;
}

module.exports = {
  MIN_OPTIONS,
  MAX_OPTIONS,
  PollError,
  normalizePollDraft,
  insertPoll,
  serializePoll,
  attachPollsToMessages,
  voteInPoll,
  addPollOption,
  stopPoll,
  emitPollUpdate,
  closeExpiredPolls,
};
