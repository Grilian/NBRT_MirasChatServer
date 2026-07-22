const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const db = require('../db');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';
// MIRAS_SERVER_URL — отдельная переменная на случай, если проверку логина когда-то
// понадобится развести с адресом чата; по умолчанию берём тот же MIRAS_URL,
// что уже настроен для пересылки сообщений (адрес туннеля в проде).
const MIRAS_SERVER_URL = process.env.MIRAS_SERVER_URL || process.env.MIRAS_URL || 'http://localhost:3000';

// Регистрация локального пользователя
router.post('/register', (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    const result = stmt.run(username, hashedPassword);
    
    res.json({ id: result.lastInsertRowid, username });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'Пользователь уже существует' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// Логин локального пользователя
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const token = jwt.sign({ id: user.id, username: user.username, source: 'local' }, JWT_SECRET);
    res.json({ token, id: user.id, username: user.username, source: 'local' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Логин через МИРАС (админ)
router.post('/login-miras', async (req, res) => {
  try {
    const { login, password } = req.body;

    // Передаём реальный IP отправителя формы — иначе на стороне МИРАС
    // защита от подбора пароля видела бы только адрес туннеля, один на всех.
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '';

    // Обращаемся к МИРАС для проверки
    const response = await axios.post(`${MIRAS_SERVER_URL}/api/admin/login`, {
      login,
      password
    }, {
      headers: { 'X-Forwarded-For': clientIp },
      timeout: 8000
    });

    const { token: mirasToken, admin } = response.data;

    // Создаём или обновляем локальную запись для админа
    const mirasUserId = `miras_${admin.id}`;
    
    // Проверяем есть ли уже запись
    let localUser = db.prepare('SELECT * FROM users WHERE username = ?').get(mirasUserId);
    
    if (!localUser) {
      // Создаём запись (пароль не нужен, авторизация через МИРАС)
      const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
      const result = stmt.run(mirasUserId, 'miras_admin');
      localUser = { id: result.lastInsertRowid, username: mirasUserId };
    }

    // Генерируем токен MirasChat
    const token = jwt.sign({ 
      id: localUser.id, 
      username: admin.login,
      source: 'miras',
      mirasId: admin.id,
      mirasRole: admin.role
    }, JWT_SECRET);

    res.json({ 
      token, 
      id: localUser.id, 
      username: admin.login,
      source: 'miras',
      role: admin.role
    });
  } catch (e) {
    if (e.response && e.response.status === 401) {
      res.status(401).json({ error: 'Неверный логин или пароль МИРАС' });
    } else if (e.response && e.response.status === 429) {
      res.status(429).json({ error: 'Слишком много попыток входа, попробуйте позже' });
    } else {
      res.status(500).json({ error: 'Ошибка подключения к МИРАС' });
    }
  }
});

module.exports = router;