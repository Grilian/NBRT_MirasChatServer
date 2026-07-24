const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { isValidLogin, isReservedLogin, isValidPassword, isValidDisplayName, PASSWORD_RESET_WINDOW_MS } = require('../utils/validators');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';

function loginSuccessPayload(user) {
  const token = jwt.sign({ id: user.id, username: user.username, source: 'local' }, JWT_SECRET);
  return {
    token,
    id: user.id,
    username: user.username,
    source: 'local',
    muted: !!user.muted,
    display_name: user.display_name || user.username,
    avatar_path: user.avatar_path || null,
    bio: user.bio || '',
    phone: user.phone || '',
    role: user.role || null,
  };
}

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

    // Самостоятельная регистрация всегда даёт Тип "интернет" (в отличие от
    // сотрудников, заведённых/подтверждённых админом) и пустую Роль — её
    // назначает админ вручную, а не дефолт "Сотрудник" на пустом месте.
    const stmt = db.prepare(
      'INSERT INTO users (username, password, display_name, account_type, role) VALUES (?, ?, ?, ?, NULL)'
    );
    const result = stmt.run(username, hashedPassword, displayName, 'internet');

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

    if (!user) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    // Админ нажал "Сменить" — password сброшен в '' (колонка NOT NULL, поэтому
    // не NULL), старый пароль больше не действует. В течение окна логин по
    // одному только логину (без проверки пароля) должен привести к экрану
    // "задайте новый пароль", а не пустить сразу в приложение — поэтому здесь
    // не сравниваем bcrypt, а сразу выдаём отдельный короткоживущий resetToken.
    if (user.password === '') {
      const elapsed = Date.now() - (user.password_reset_requested_at || 0);
      if (elapsed > PASSWORD_RESET_WINDOW_MS) {
        return res.status(401).json({ error: 'Пароль недействителен, обратитесь к администратору' });
      }

      const resetToken = jwt.sign({ id: user.id, purpose: 'password_reset' }, JWT_SECRET, { expiresIn: '15m' });
      return res.json({ mustSetPassword: true, resetToken });
    }

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    res.json(loginSuccessPayload(user));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Завершение сброса пароля — вызывается со специального resetToken, который
// выдал /login, когда обнаружил, что пароль обнулён администратором.
router.post('/complete-reset', (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    let decoded;
    try {
      decoded = jwt.verify(String(resetToken || ''), JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Ссылка на сброс пароля недействительна' });
    }
    if (decoded.purpose !== 'password_reset') {
      return res.status(401).json({ error: 'Ссылка на сброс пароля недействительна' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Повторная проверка на случай, если окно истекло между /login и этим
    // запросом, или пароль уже был установлен из другой вкладки/устройства.
    if (user.password !== '') {
      return res.status(401).json({ error: 'Пароль уже установлен, войдите обычным способом' });
    }
    const elapsed = Date.now() - (user.password_reset_requested_at || 0);
    if (elapsed > PASSWORD_RESET_WINDOW_MS) {
      return res.status(401).json({ error: 'Пароль недействителен, обратитесь к администратору' });
    }

    if (!isValidPassword(String(newPassword || ''))) {
      return res.status(400).json({ error: 'Пароль: не короче 5 символов и без кириллицы' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ?, password_reset_requested_at = NULL WHERE id = ?')
      .run(hashedPassword, user.id);

    res.json(loginSuccessPayload({ ...user, password: hashedPassword }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;