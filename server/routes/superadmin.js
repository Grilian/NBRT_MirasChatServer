const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const verifySuperAdmin = require('../middleware/verifySuperAdmin');
const { isValidLogin, isReservedLogin, PASSWORD_RESET_WINDOW_MS } = require('../utils/validators');
const { archiveAndDeleteUser } = require('../services/accountArchive');
const { applyModeration, notifyModerated } = require('../services/userModeration');
const { getUpdateNotBefore, setUpdateNotBefore } = require('../services/appSettings');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';

// 'ok' — обычный, рабочий пароль; 'pending' — админ нажал "Сменить", ждём,
// что человек зайдёт и задаст новый в течение окна; 'expired' — окно прошло,
// логин заблокирован, пока админ не нажмёт "Сменить" ещё раз.
// Пустая строка — сентинел "пароль сброшен": колонка password NOT NULL,
// так что NULL сюда не годится, а bcrypt-хэш никогда не бывает пустым.
function passwordStatus(user) {
  if (user.password !== '') return 'ok';
  if (!user.password_reset_requested_at) return 'ok';
  return (Date.now() - user.password_reset_requested_at) <= PASSWORD_RESET_WINDOW_MS ? 'pending' : 'expired';
}

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
      SELECT u.id, u.username, u.display_name, u.group_id, u.role, u.muted, u.account_type,
             u.password, u.password_reset_requested_at, g.name AS group_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      ORDER BY u.username
    `).all();

    res.json(users.map((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      group_id: u.group_id,
      group_name: u.group_name,
      role: u.role || null,
      muted: !!u.muted,
      account_type: u.account_type || 'staff',
      password_status: passwordStatus(u),
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

    // Логин — только у супер-админа (не входит в общую "модерацию", доступную
    // и с ролью "Администратор" из обычного клиента).
    if (req.body.username !== undefined) {
      const nextUsername = String(req.body.username).trim();
      if (isReservedLogin(nextUsername) || !isValidLogin(nextUsername)) {
        return res.status(400).json({ error: 'Логин: 5-32 символов, латиница, цифры и подчёркивание, должен начинаться с буквы' });
      }

      const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(nextUsername, id);
      if (existing) return res.status(400).json({ error: 'Это имя уже занято' });

      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(nextUsername, id);
    }

    const updated = applyModeration(id, {
      group_id: req.body.group_id,
      role: req.body.role,
      account_type: req.body.account_type,
      muted: req.body.muted,
    });

    notifyModerated(req.app.get('io'), updated);

    const full = db.prepare('SELECT password, password_reset_requested_at FROM users WHERE id = ?').get(id);

    res.json({
      id: updated.id,
      username: updated.username,
      display_name: updated.display_name,
      group_id: updated.group_id,
      group_name: updated.group_name,
      role: updated.role || null,
      muted: !!updated.muted,
      account_type: updated.account_type || 'staff',
      password_status: passwordStatus(full),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// "Сменить" пароль — полностью инвалидирует старый пароль (не даёт админу
// ввести новый за пользователя). У человека есть PASSWORD_RESET_WINDOW_MS на
// то, чтобы зайти под своим логином и задать новый пароль самостоятельно —
// см. /api/auth/login и /api/auth/complete-reset.
router.post('/users/:id/reset-password', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = db.prepare("UPDATE users SET password = '', password_reset_requested_at = ? WHERE id = ?")
      .run(Date.now(), id);
    if (result.changes === 0) return res.status(404).json({ error: 'Пользователь не найден' });

    res.json({ password_status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Полное удаление аккаунта вместе с историей переписки (архивируется на диск
// перед удалением). В отличие от самостоятельного удаления, тут разрешено
// удалять и служебные miras_-зеркала — ради тестирования и очистки этих
// оставшихся с интеграции МИРАС записей.
router.post('/users/:id/delete', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = archiveAndDeleteUser(id, { allowMirror: true });
    if (!result) return res.status(404).json({ error: 'Пользователь не найден' });

    res.json({ ok: true, backupFile: result.backupFile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Момент, раньше которого клиенты не ставят скачанное обновление. Пусто —
// ставят сразу. Само по себе это расписание ничего не откладывает: клиент
// сверяет его с датой сборки из latest.yml, и время, назначенное раньше, чем
// залит билд, срабатывает как «сразу» (подробности в README).
router.get('/update-schedule', verifySuperAdmin, (req, res) => {
  res.json({ notBefore: getUpdateNotBefore() });
});

router.put('/update-schedule', verifySuperAdmin, (req, res) => {
  try {
    const raw = req.body.notBefore;

    if (raw === null || raw === undefined || raw === '') {
      setUpdateNotBefore(null);
      return res.json({ notBefore: null });
    }

    const ms = Number(raw);
    if (!Number.isFinite(ms)) {
      return res.status(400).json({ error: 'Некорректный момент времени' });
    }

    setUpdateNotBefore(ms);
    res.json({ notBefore: ms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
