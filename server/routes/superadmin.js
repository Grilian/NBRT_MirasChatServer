const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const verifySuperAdmin = require('../middleware/verifySuperAdmin');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';
const VALID_ROLES = ['user', 'moderator', 'admin'];

// Простой rate-limit на логин супер-админа — панель публично доступна из браузера,
// та же логика, что и у /api/admin/login на МИРАСе (5 попыток / 10 минут на IP).
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) loginAttempts.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function loginRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttemptAt: now });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Слишком много попыток входа, попробуйте позже' });
  }

  entry.count += 1;
  next();
}

router.post('/login', loginRateLimit, (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const admin = db.prepare('SELECT * FROM super_admins WHERE username = ?').get(username);

    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign(
      { id: admin.id, role: 'superadmin', username: admin.username },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, username: admin.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Группы =====

router.get('/groups', verifySuperAdmin, (req, res) => {
  try {
    const groups = db.prepare(`
      SELECT g.id, g.name, COUNT(u.id) AS member_count
      FROM groups g
      LEFT JOIN users u ON u.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name
    `).all();
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/groups', verifySuperAdmin, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const result = db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
    res.json({ id: result.lastInsertRowid, name, member_count: 0 });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Группа с таким названием уже есть' });
    }
    res.status(500).json({ error: e.message });
  }
});

router.put('/groups/:id', verifySuperAdmin, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const result = db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Группа не найдена' });

    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Группа с таким названием уже есть' });
    }
    res.status(500).json({ error: e.message });
  }
});

router.delete('/groups/:id', verifySuperAdmin, (req, res) => {
  try {
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET group_id = NULL WHERE group_id = ?').run(req.params.id);
      return db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id).changes;
    });
    const changes = tx();
    if (changes === 0) return res.status(404).json({ error: 'Группа не найдена' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Пользователи =====

router.get('/users', verifySuperAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.group_id, u.role, u.muted, g.name AS group_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      ORDER BY u.username
    `).all();

    res.json(users.map((u) => ({
      ...u,
      muted: !!u.muted,
      role: u.role || 'user',
      isMirror: u.username.startsWith('miras_')
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const updates = [];
    const params = [];

    if (req.body.username !== undefined) {
      const nextUsername = String(req.body.username).trim();
      if (!nextUsername) return res.status(400).json({ error: 'Имя не может быть пустым' });

      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(nextUsername, id);
      if (existing) return res.status(400).json({ error: 'Это имя уже занято' });

      updates.push('username = ?');
      params.push(nextUsername);
    }

    if (req.body.password) {
      const pw = String(req.body.password);
      if (pw.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });

      updates.push('password = ?');
      params.push(bcrypt.hashSync(pw, 10));
    }

    if (req.body.group_id !== undefined) {
      const groupId = req.body.group_id === null ? null : Number(req.body.group_id);
      if (groupId !== null) {
        const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
        if (!group) return res.status(400).json({ error: 'Группа не найдена' });
      }
      updates.push('group_id = ?');
      params.push(groupId);
    }

    if (req.body.role !== undefined) {
      const role = String(req.body.role);
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Некорректная роль' });
      updates.push('role = ?');
      params.push(role);
    }

    if (req.body.muted !== undefined) {
      updates.push('muted = ?');
      params.push(req.body.muted ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare(`
      SELECT u.id, u.username, u.group_id, u.role, u.muted, g.name AS group_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id = ?
    `).get(id);

    // Живое уведомление клиенту — режим тишины/роль/группа должны подействовать
    // сразу, не дожидаясь перелогина.
    const io = req.app.get('io');
    if (io) {
      io.to('user:' + id).emit('account_updated', {
        muted: !!updated.muted,
        role: updated.role,
        group_id: updated.group_id
      });
    }

    res.json({ ...updated, muted: !!updated.muted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
