const express = require('express');
const { getUpdateNotBefore } = require('../services/appSettings');

const router = express.Router();

// Без авторизации намеренно. Расписание читает main-процесс Electron, а
// сессии у него нет — токен живёт в рендерере, и тащить его в main ради одной
// метки времени незачем. Скрывать в этом ответе тоже нечего: он не говорит ни
// про людей, ни про переписку, только про то, когда встанет обновление.
router.get('/schedule', (req, res) => {
  res.json({ notBefore: getUpdateNotBefore() });
});

module.exports = router;
