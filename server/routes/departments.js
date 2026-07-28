const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');

const router = express.Router();

// Справочник отделов для выпадающих списков: профиль, подбор участников
// события. Заводит и переименовывает их супер-админ (см. routes/superadmin.js),
// здесь только чтение.
router.get('/', verifyToken, (req, res) => {
  try {
    const departments = db.prepare(`
      SELECT d.id, d.name, COUNT(u.id) AS member_count
      FROM departments d
      LEFT JOIN users u ON u.department_id = d.id
      GROUP BY d.id
      ORDER BY d.name
    `).all();
    res.json(departments);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
