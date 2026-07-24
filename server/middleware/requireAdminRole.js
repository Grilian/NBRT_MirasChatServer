const db = require('../db');

// Работает поверх verifyToken (req.userId уже проверен JWT-подписью) — здесь
// довешиваем проверку роли из БД, а не из токена: роль может смениться уже
// после выдачи токена (обычные пользовательские токены не имеют срока
// действия), так что доверять можно только текущему значению в базе.
module.exports = (req, res, next) => {
  try {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
