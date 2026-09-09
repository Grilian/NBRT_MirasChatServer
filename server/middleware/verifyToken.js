const jwt = require('jsonwebtoken');
const { epochValid } = require('../services/tokenEpoch');

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_super_secret_key');
    // Подпись верна — но токен мог быть отозван: сменой пароля или кнопкой
    // «Выйти на других устройствах». Бессрочный токен без этой сверки живёт
    // вечно, и смена пароля не выгоняет того, кто его подсмотрел.
    // МИРАС-токены сюда не попадают: у них свой источник и своя проверка.
    if ((decoded.source || 'local') === 'local' && !epochValid(decoded)) {
      return res.status(401).json({ error: 'Сеанс завершён' });
    }
    req.userId = decoded.id;
    req.tokenSource = decoded.source || 'local';
    req.mirasRole = decoded.mirasRole || null;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
};