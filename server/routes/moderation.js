const express = require('express');
const db = require('../db');
const { applyModeration, notifyModerated } = require('../services/userModeration');
const router = express.Router();

// Встроенное админ-управление в профиле пользователя (для тех, у кого роль
// "Администратор") — тишина/тип/группа/роль/отдел, без логина, пароля и
// удаления аккаунта (это остаётся только в панели супер-админа).
// Маршрут уже защищён verifyToken + requireAdminRole (см. index.js).

router.get('/groups', (req, res) => {
  try {
    const groups = db.prepare('SELECT id, name FROM groups ORDER BY name').all();
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Справочник отделов лежит и в /api/departments, но там он для всех, а этот
// маршрут уже под ролью «Администратор» — клиенту проще брать оба списка из
// одного места, не разбираясь, какой откуда.
router.get('/departments', (req, res) => {
  try {
    const departments = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
    res.json(departments);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/users/:id', (req, res) => {
  try {
    const user = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.group_id, u.role, u.muted, u.account_type,
             g.name AS group_name, u.department_id, d.name AS department_name
      FROM users u
      LEFT JOIN groups g ON g.id = u.group_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?
    `).get(Number(req.params.id));

    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    res.json({ ...user, muted: !!user.muted, role: user.role || null, account_type: user.account_type || 'staff' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const updated = applyModeration(id, {
      group_id: req.body.group_id,
      role: req.body.role,
      account_type: req.body.account_type,
      muted: req.body.muted,
      department_id: req.body.department_id,
    });
    if (!updated) return res.status(404).json({ error: 'Пользователь не найден' });

    notifyModerated(req.app.get('io'), updated);

    res.json({ ...updated, muted: !!updated.muted, role: updated.role || null, account_type: updated.account_type || 'staff' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
