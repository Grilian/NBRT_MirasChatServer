const db = require('../db');

// Мираам-админам нужна настоящая строка в users, иначе JOIN'ы в
// messages/comments/favorites (все ссылаются на users.id) их не найдут.
function ensureLocalUserForAdmin(adminLogin) {
  const username = `miras_admin_${adminLogin}`;

  let user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

  if (!user) {
    const result = db
      .prepare('INSERT INTO users (username, password) VALUES (?, ?)')
      .run(username, 'miras_admin');

    user = { id: result.lastInsertRowid };
  }

  return user.id;
}

module.exports = { ensureLocalUserForAdmin };
