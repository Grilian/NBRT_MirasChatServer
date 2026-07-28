const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');

const router = express.Router();

// Платформы фиксированным списком: строка приходит от клиента, а попадает в
// панель управления, где её читает человек. Свободный текст оттуда пришлось бы
// экранировать и всё равно гадать, что значит очередное написание.
const PLATFORMS = new Set(['desktop', 'android', 'web']);

// Версия — это '1.3.5' у приложений и короткий git-хэш у веба. Ограничение
// длины и набора символов: в панели она показывается как есть.
const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,32}$/;

/**
 * Клиент сообщает, какая у него версия. Вызывается при запуске приложения.
 *
 * Молча отвечаем ok даже на мусор: это телеметрия, и ронять из-за неё запуск
 * приложения нельзя. Некорректное значение просто не сохраняем.
 */
router.post('/version', verifyToken, (req, res) => {
  try {
    const platform = String(req.body.platform || '');
    const version = String(req.body.version || '');

    if (!PLATFORMS.has(platform) || !VERSION_PATTERN.test(version)) {
      return res.json({ ok: false });
    }

    db.prepare(`
      INSERT INTO user_app_versions (user_id, platform, version, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, platform) DO UPDATE SET
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(req.userId, platform, version, Date.now());

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
