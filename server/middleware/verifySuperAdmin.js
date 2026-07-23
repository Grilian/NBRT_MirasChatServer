const jwt = require('jsonwebtoken');

// Отдельный токен от обычных сотрудников/МИРАС-логина — форма другая
// (role: 'superadmin' вместо source/mirasRole), поэтому не переиспользуем verifyToken.
module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_super_secret_key');
    if (decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    req.superAdminId = decoded.id;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
};
