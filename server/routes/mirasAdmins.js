const express = require('express');
const mirasService = require('../services/mirasService');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

router.get('/', verifyToken, async (req, res) => {
  try {
    const admins = await mirasService.getMirasAdmins();
    res.json(admins);
  } catch (e) {
    console.error('Ошибка:', e.message);
    res.status(500).json({ error: 'Не удалось получить список админов' });
  }
});

module.exports = router;