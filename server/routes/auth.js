const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { isValidLogin, isReservedLogin, isValidPassword, isValidDisplayName } = require('../utils/validators');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';

// Регистрация локального пользователя. Логин/пароль/имя валидируются строго
// только здесь и далее при их изменении — уже существующие учётки (заведённые
// до этих правил) не переоцениваются на вход, чтобы никого не заблокировать.
router.post('/register', (req, res) => {
  try {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    const displayName = String(req.body.display_name || '').trim();

    if (isReservedLogin(username) || !isValidLogin(username)) {
      return res.status(400).json({ error: 'Логин: 5-32 символов, латиница, цифры и подчёркивание, должен начинаться с буквы' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Пароль: не короче 5 символов и без кириллицы' });
    }
    if (!isValidDisplayName(displayName)) {
      return res.status(400).json({ error: 'Имя: от 2 до 64 символов' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const stmt = db.prepare('INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)');
    const result = stmt.run(username, hashedPassword, displayName);

    res.json({ id: result.lastInsertRowid, username, display_name: displayName });
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
    res.json({
      token,
      id: user.id,
      username: user.username,
      source: 'local',
      muted: !!user.muted,
      display_name: user.display_name || user.username,
      avatar_path: user.avatar_path || null,
      bio: user.bio || '',
      phone: user.phone || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;