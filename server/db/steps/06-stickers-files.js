// Стикеры и вложения-файлы.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
  // Стикеры — самостоятельный тип сообщения, а не подстановка внутри текста
  // (как кастомные смайлики): их не печатают кодом, значит не нужны ни
  // глобально уникальное имя, ни разбор шорткодов. Структура паков/элементов
  // та же, что у emoji_packs/emoji_items, просто без этой части.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sticker_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cover_path TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sticker_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      emoji TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id);
  `);

  // sticker_id — ссылка на элемент пака (резолвится через живой каталог, как
  // :code: у смайликов), простой INTEGER без FK-объявления — так же, как
  // reply_to_id/thread_root_id: внешние ключи в этой базе нигде не проверяются
  // движком (PRAGMA foreign_keys не включена), а удаление стикера в админке НЕ
  // обязано трогать строку сообщения. sticker_fallback — копия emoji элемента
  // НА МОМЕНТ ОТПРАВКИ: в отличие от смайлика, стикер не может деградировать
  // до текста при удалении картинки, поэтому нужен готовый глиф про запас.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sticker_id INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sticker_fallback TEXT`);
  } catch (e) {
    // Колонка уже есть
  }

  // Файлы (документы, архивы) — ОТДЕЛЬНЫЕ колонки от картинок, а не общий
  // «attachment». Картинка и файл ведут себя по-разному во всём: картинка
  // пережимается в webp и показывается прямо в ленте, файл сохраняется как есть
  // и показывается карточкой со скачиванием. Свести их в одну пару колонок
  // значило бы на каждом шаге спрашивать «а это картинка или нет» — ровно тот
  // разбор, которого удалось избежать у поллов и стикеров.
  //
  // document_name хранится отдельно от пути: на диске имя обеззараживается и
  // дополняется случайной частью, а человеку надо показать то, что он отправил.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN document_path TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN document_name TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN document_size INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN document_mime TEXT`);
  } catch (e) {
    // Колонка уже есть
  }

  // Убранное вложение: файл уезжает в zip в личной папке отправителя, а само
  // сообщение остаётся на месте. Хранить обязаны и то и другое — содержимое
  // переписки по закону не удаляется, но из приложения вложение должно пропасть.
  // Поэтому не «удалено», а «архивировано»: путь к архиву тут же, рядом.
  // Фото профиля группы — правит владелец. Хранится как путь, ровно как
  // аватар человека; сам файл лежит в личной папке того, кто его загрузил.
  try {
    db.exec(`ALTER TABLE chat_groups ADD COLUMN avatar_path TEXT`);
  } catch (e) {
    // Колонка уже есть
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN attachment_archived_at INTEGER`);
  } catch (e) {
    // Колонка уже есть
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN attachment_archive_path TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
};
