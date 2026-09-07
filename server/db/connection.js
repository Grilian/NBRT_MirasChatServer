const Database = require('better-sqlite3');
const path = require('path');

// В тестах сервисов используем отдельную временную БД. В обычном запуске
// путь остаётся прежним, поэтому это не меняет расположение продовых данных.
//
// `..` тут обязателен и стоил отдельной поломки: при разборе db.js на шаги
// файл переехал в server/db/, а путь остался «рядом со мной» — сервер молча
// завёл ПУСТУЮ базу в server/db/messenger.db и поднялся на ней. Ни один тест
// этого не увидел: все они задают MIRAS_DB_PATH и до значения по умолчанию не
// доходят. База всегда лежит в корне server/, где бы ни лежал этот файл.
const dbPath = process.env.MIRAS_DB_PATH
  ? path.resolve(process.env.MIRAS_DB_PATH)
  : path.join(__dirname, '..', 'messenger.db');
const db = new Database(dbPath);

// Оптимизация
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('busy_timeout = 5000');

module.exports = db;
