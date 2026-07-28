const db = require('../db');

// Момент, раньше которого клиентам не следует ставить уже скачанное
// обновление. Unix-миллисекунды, как и остальные наши метки времени: у SQLite
// CURRENT_TIMESTAMP нет таймзоны в строке, и разбор такой строки в JS даёт
// сдвиг на часовой пояс читающего — ровно та путаница, из-за которой время
// сброса пароля тоже хранится числом.
const UPDATE_NOT_BEFORE = 'update_not_before';

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), Date.now());
}

function getUpdateNotBefore() {
  const raw = getSetting(UPDATE_NOT_BEFORE);
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : null;
}

function setUpdateNotBefore(ms) {
  setSetting(UPDATE_NOT_BEFORE, ms === null ? null : String(ms));
}

module.exports = { getUpdateNotBefore, setUpdateNotBefore };
