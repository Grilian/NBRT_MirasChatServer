const db = require('./connection');

// Схема разложена на шаги и применяется по порядку. Раньше это был один файл на
// 1390 строк, где создание таблиц и полсотни `ALTER` шли вперемешку: понять,
// что уже есть в базе, можно было только прочитав всё подряд.
//
// Каждый шаг идемпотентен — `CREATE TABLE IF NOT EXISTS` и `ALTER` в try/catch,
// — поэтому применяются они на КАЖДОМ старте. Отдельного журнала применённых
// миграций нет намеренно: он потребовал бы отдельной таблицы и разбирательств
// с базами, заведёнными до него, а выигрыша не дал бы — прогон по чистой базе
// занимает миллисекунды.
//
// ПОРЯДОК ЗНАЧИМ: поздние шаги опираются на таблицы и колонки ранних.
for (const step of [
  require('./steps/01-schema'),
  require('./steps/02-emoji'),
  require('./steps/03-messages'),
  require('./steps/04-users-groups'),
  require('./steps/05-google-calendar'),
  require('./steps/06-stickers-files'),
  require('./steps/07-seed'),
  require('./steps/08-normalize'),
  require('./steps/09-tasks'),
]) {
  step(db);
}

module.exports = db;
