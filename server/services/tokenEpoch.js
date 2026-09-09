const db = require('../db');

/**
 * Эпоха токена — единственный способ отозвать выданный токен.
 *
 * Токены бессрочны, поэтому «выйти везде» и «смена пароля выгоняет остальных»
 * держатся только на этом номере: он лежит в токене и сверяется при каждой
 * проверке. Правило живёт ОДНИМ модулем, потому что спрашивают его из трёх
 * мест — HTTP-проверка, сокет и сами точки отзыва, — и три копии этого
 * сравнения разъехались бы на первой же правке.
 */

const readEpoch = db.prepare('SELECT token_epoch FROM users WHERE id = ?');
const bumpEpoch = db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?');

/** Текущая эпоха человека. `null` — такого пользователя нет. */
function currentEpoch(userId) {
  const row = readEpoch.get(Number(userId));
  return row ? Number(row.token_epoch) : null;
}

/**
 * Годен ли токен по эпохе.
 *
 * Токен БЕЗ эпохи считается первой: такие выданы до появления отзыва, и
 * объявить их негодными значило бы разлогинить разом всю организацию на ровном
 * месте. Первый же отзыв поднимет номер и отсечёт их вместе с остальными.
 */
function epochValid(decoded) {
  const epoch = currentEpoch(decoded && decoded.id);
  if (epoch === null) return false;
  const fromToken = Number(decoded.epoch ?? 1);
  return fromToken === epoch;
}

/** Отозвать все выданные токены человека. Возвращает НОВУЮ эпоху. */
function revokeTokens(userId) {
  bumpEpoch.run(Number(userId));
  return currentEpoch(userId);
}

module.exports = { currentEpoch, epochValid, revokeTokens };
