const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

const MAX_TOKEN_LENGTH = 4096;
const PLATFORMS = ['android', 'ios'];

// Регистрация токена FCM. Клиент зовёт это при каждом запуске приложения, а не
// только при логине: Firebase переиздаёт токен сам (переустановка, очистка
// данных, восстановление из бэкапа), и пропущенное обновление означает, что
// человек молча перестаёт получать уведомления.
router.post('/', verifyToken, (req, res) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const platform = PLATFORMS.includes(req.body.platform) ? req.body.platform : 'android';

    if (!token || token.length > MAX_TOKEN_LENGTH) {
      return res.status(400).json({ error: 'Некорректный токен' });
    }

    // Токен уже мог быть записан на другого пользователя — тот же телефон,
    // сменился сотрудник. Переносим строку, а не создаём вторую: иначе на
    // устройство пошли бы пуши сразу за двоих.
    db.prepare(`
      INSERT INTO device_tokens (user_id, token, platform, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(token) DO UPDATE SET
        user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.userId, token, platform);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Снятие токена при выходе из аккаунта. Удаляем строго по паре токен+владелец:
// если на телефоне уже успел залогиниться кто-то другой, его регистрация
// должна пережить наш отложенный (или повторный) выход.
router.delete('/', verifyToken, (req, res) => {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!token) return res.status(400).json({ error: 'Некорректный токен' });

    db.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?').run(token, req.userId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
