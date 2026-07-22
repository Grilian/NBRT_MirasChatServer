const express = require('express');
const mirasService = require('../services/mirasService');
const { ensureLocalUserForAdmin } = require('../services/mirasAdminUsers');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

router.get('/', verifyToken, async (req, res) => {
  try {
    const admins = await mirasService.getMirasAdmins();

    // Подменяем id на локальный users.id, чтобы комментарии/избранное/сообщения
    // для админов работали так же, как для локальных пользователей.
    const withLocalIds = admins.map(a => ({
      ...a,
      id: ensureLocalUserForAdmin(a.login)
    }));

    res.json(withLocalIds);
  } catch (e) {
    console.error('Ошибка:', e.message);
    res.status(500).json({ error: 'Не удалось получить список админов' });
  }
});

module.exports = router;