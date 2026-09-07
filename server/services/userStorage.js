const fs = require('fs');
const path = require('path');

// Личная папка каждого пользователя.
//
// Раньше загрузки лежали общей кучей по типам (`uploads/chat-images`,
// `uploads/chat-files`, `uploads/avatars`, `uploads/backgrounds`): чтобы
// понять, чьё это и сколько человек занимает, приходилось разбирать имена
// файлов, а «убрать за уволившимся» было нечем — файлы вперемешку. Теперь всё,
// что принадлежит человеку, лежит под одним каталогом:
//
//   uploads/users/<id>/images/     картинки его сообщений
//   uploads/users/<id>/files/      отправленные им файлы
//   uploads/users/<id>/avatar/     аватар
//   uploads/users/<id>/wallpaper/  обои переписки
//   uploads/users/<id>/archive/    архивы убранных вложений (zip)
//
// Смайлики и стикеры сюда НЕ переезжают — они общие для всей организации и
// ничьей личной собственностью не являются.
//
// Переезд со старой раскладки (`migrateLegacyUploads`) удалён 07.09.2026: он
// шёл на КАЖДОМ старте сервера, а переносить давно нечего — на проде ноль
// строк со старыми путями. Старые пути больше не считаются допустимыми и при
// отправке.
//
// Владелец файла определяется по ОТПРАВИТЕЛЮ, а не по получателю: пересланная
// копия ссылается на тот же файл, и раскладывать его дважды незачем.

// Каталог настраивается переменной окружения ровно ради тестов: миграция
// переносит файлы и правит пути в базе, и запускать её по настоящим загрузкам
// с временной базой — верный способ развести файлы и строки в разные стороны
// (поймано на первом же прогоне).
const UPLOADS_DIR = process.env.MIRAS_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const USERS_DIR = path.join(UPLOADS_DIR, 'users');

const KINDS = ['images', 'files', 'avatar', 'wallpaper', 'archive'];

/** Каталог человека под нужный вид файлов; создаётся по требованию. */
function userDir(userId, kind) {
  if (!KINDS.includes(kind)) throw new Error(`Неизвестный вид файлов: ${kind}`);
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Некорректный владелец файла');
  const dir = path.join(USERS_DIR, String(id), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Путь, каким его видит клиент: /uploads/users/<id>/<kind>/<file>. */
function publicPath(userId, kind, filename) {
  return `/uploads/users/${Number(userId)}/${kind}/${filename}`;
}

const USER_PATH_PATTERN = new RegExp(
  `^/uploads/users/(\\d+)/(${KINDS.join('|')})/([a-zA-Z0-9_.-]+)$`
);

/**
 * Разбор пути, пришедшего от клиента.
 *
 * Проверка нужна там же, где и раньше: путь к файлу клиент присылает сам
 * (сначала загрузка, потом сокет-сообщение с этим путём), и без разбора можно
 * было бы подсунуть чужой файл или `..` в имени.
 */
function parseUserPath(value) {
  if (typeof value !== 'string' || value.includes('..')) return null;
  const m = USER_PATH_PATTERN.exec(value);
  if (!m) return null;
  return { userId: Number(m[1]), kind: m[2], filename: m[3] };
}

/** Абсолютный путь по публичному, только внутри uploads. */
function absoluteFromPublic(value) {
  if (typeof value !== 'string' || !value.startsWith('/uploads/') || value.includes('..')) return null;
  const abs = path.join(UPLOADS_DIR, value.slice('/uploads/'.length));
  // Двойная защита: даже если шаблон когда-нибудь ослабят, за пределы
  // uploads выйти нельзя.
  const rel = path.relative(UPLOADS_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * Владелец по имени файла: `msg_<id>_…`, `doc_<id>_…`, `user_<id>_…`, `bg_<id>_…`.
 *
 * Имя надёжнее строки в БД: одна и та же картинка бывает в нескольких
 * сообщениях (пересылка), и владельцем должен остаться тот, кто её загрузил, а
 * не тот, кто переслал первым.
 */
function ownerFromFilename(filename) {
  const m = /^(?:msg|doc|user|bg)_(\d+)_/.exec(String(filename || ''));
  return m ? Number(m[1]) : null;
}

module.exports = {
  UPLOADS_DIR,
  USERS_DIR,
  KINDS,
  userDir,
  publicPath,
  parseUserPath,
  absoluteFromPublic,
  ownerFromFilename,
};
