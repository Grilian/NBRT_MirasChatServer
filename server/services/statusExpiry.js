const db = require('../db');

// Статусы с истёкшим сроком снимаем лениво — перед любой выдачей, где статус
// виден. Планировщик тут был бы лишним: между тиками статус всё равно
// показывался бы устаревшим, а пережить перезапуск pm2 (он случается при
// каждой выкладке) ему сложнее, чем одному UPDATE на запрос.
//
// Людей в организации пара сотен, строка со сроком — редкость, так что это
// один дешёвый UPDATE, почти всегда затрагивающий ноль строк.
function clearExpiredStatuses() {
  try {
    db.prepare(`
      UPDATE users
      SET status_preset = NULL, status_custom = NULL, status_expires_at = NULL
      WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?
    `).run(Date.now());
  } catch (e) {
    // Статус — необязательная мелочь: не отдать список людей из-за неё нельзя.
    console.error('Не удалось снять истёкшие статусы:', e.message);
  }
}

module.exports = { clearExpiredStatuses };
