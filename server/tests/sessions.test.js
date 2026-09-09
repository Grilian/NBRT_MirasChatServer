const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `miras-sessions-${process.pid}-${Date.now()}.db`);
process.env.MIRAS_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miras-sessions-uploads-'));
process.env.MIRAS_DB_PATH = dbPath;
process.env.JWT_SECRET = 'sessions-test-secret';

const jwt = require('jsonwebtoken');
const db = require('../db');
const { currentEpoch, epochValid, revokeTokens } = require('../services/tokenEpoch');

function createUser(username) {
  return Number(db.prepare(
    'INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)'
  ).run(username, 'x', username).lastInsertRowid);
}

test('смена эпохи отзывает ранее выданные токены', () => {
  // Дыра, найденная пользователем 09.09.2026: аккаунт открыт на двух
  // устройствах, на одном меняют пароль — второе продолжает работать.
  const userId = createUser('epoch_user');
  const before = currentEpoch(userId);
  const oldToken = { id: userId, source: 'local', epoch: before };

  assert.equal(epochValid(oldToken), true);

  const after = revokeTokens(userId);
  assert.equal(after, before + 1);
  // Старое устройство отваливается…
  assert.equal(epochValid(oldToken), false);
  // …а новое, получившее свежий токен, работает.
  assert.equal(epochValid({ id: userId, source: 'local', epoch: after }), true);
});

test('токен без эпохи считается первой — иначе разлогинило бы всех разом', () => {
  // Выданные до появления отзыва токены эпохи не содержат. Объявить их
  // негодными значило бы выгнать всю организацию на ровном месте; первый же
  // отзыв поднимет номер и отсечёт их вместе с остальными.
  const userId = createUser('legacy_token_user');
  assert.equal(epochValid({ id: userId, source: 'local' }), true);

  revokeTokens(userId);
  assert.equal(epochValid({ id: userId, source: 'local' }), false);
});

test('несуществующий пользователь не проходит ни с каким токеном', () => {
  assert.equal(epochValid({ id: 999999, source: 'local', epoch: 1 }), false);
});

test('подпись верна, но токен отозван — это разные отказы', () => {
  // Подпись проверяет, что токен наш; эпоха — что он ещё в силе. Второе без
  // первого бессмысленно, первое без второго — бессрочный пропуск.
  const userId = createUser('signed_but_revoked');
  const token = jwt.sign(
    { id: userId, source: 'local', epoch: currentEpoch(userId) },
    process.env.JWT_SECRET,
  );
  revokeTokens(userId);

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.id, userId, 'подпись осталась верной');
  assert.equal(epochValid(decoded), false, 'но сеанс уже завершён');
});
