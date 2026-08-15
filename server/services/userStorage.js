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

// ===== Переезд со старой раскладки =====
//
// Порядок шагов важен: КОПИЯ → правка пути в БД → удаление исходника. При
// обратном порядке (перенос, потом правка) падение процесса посередине
// оставило бы строку, указывающую в пустоту, — картинка исчезла бы из
// переписки. При таком порядке худший исход — лишняя копия на диске, которую
// уберёт следующий запуск.

const LEGACY_MAP = [
  { prefix: '/uploads/chat-images/', kind: 'images' },
  { prefix: '/uploads/chat-files/', kind: 'files' },
  { prefix: '/uploads/avatars/', kind: 'avatar' },
  { prefix: '/uploads/backgrounds/', kind: 'wallpaper' },
];

const legacyKindOf = (value) => LEGACY_MAP.find((item) => String(value || '').startsWith(item.prefix)) || null;

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

function moveOne(legacyPath, ownerId) {
  const legacyAbs = absoluteFromPublic(legacyPath);
  if (!legacyAbs) return null;
  const filename = path.basename(legacyPath);
  const kind = legacyKindOf(legacyPath)?.kind;
  if (!kind) return null;

  const target = path.join(userDir(ownerId, kind), filename);
  if (!fs.existsSync(target)) {
    if (!fs.existsSync(legacyAbs)) return null; // нечего переносить
    fs.copyFileSync(legacyAbs, target);
  }
  return { newPath: publicPath(ownerId, kind, filename), legacyAbs };
}

/**
 * Разложить всё, что лежит по-старому, по личным папкам.
 *
 * Идемпотентно: уже перенесённое не подходит под LEGACY_MAP и пропускается.
 * Запускается на старте сервера — файлов немного (сотни), и отдельная команда,
 * о которой нужно помнить при выкладке, тут была бы лишним источником
 * «забыли выполнить».
 */
function migrateLegacyUploads(db) {
  const moved = { images: 0, files: 0, avatar: 0, wallpaper: 0, orphans: 0 };
  const done = new Map(); // старый путь → новый, чтобы не копировать дважды

  const relocate = (legacyPath, fallbackOwner) => {
    if (done.has(legacyPath)) return done.get(legacyPath);
    const owner = ownerFromFilename(path.basename(legacyPath)) || fallbackOwner;
    if (!owner) return null;
    const result = moveOne(legacyPath, owner);
    if (result) done.set(legacyPath, result);
    return result;
  };

  const rows = db.prepare(`
    SELECT id, sender_id, file_path, document_path
    FROM messages
    WHERE file_path LIKE '/uploads/chat-%' OR document_path LIKE '/uploads/chat-%'
  `).all();

  for (const row of rows) {
    if (legacyKindOf(row.file_path)) {
      const result = relocate(row.file_path, row.sender_id);
      if (result) {
        db.prepare('UPDATE messages SET file_path = ? WHERE file_path = ?').run(result.newPath, row.file_path);
        moved.images += 1;
      }
    }
    if (legacyKindOf(row.document_path)) {
      const result = relocate(row.document_path, row.sender_id);
      if (result) {
        db.prepare('UPDATE messages SET document_path = ? WHERE document_path = ?')
          .run(result.newPath, row.document_path);
        moved.files += 1;
      }
    }
  }

  const users = db.prepare(`
    SELECT id, avatar_path, chat_background_path
    FROM users
    WHERE avatar_path LIKE '/uploads/avatars/%' OR chat_background_path LIKE '/uploads/backgrounds/%'
  `).all();

  for (const user of users) {
    if (legacyKindOf(user.avatar_path)) {
      const result = relocate(user.avatar_path, user.id);
      if (result) {
        db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(result.newPath, user.id);
        moved.avatar += 1;
      }
    }
    if (legacyKindOf(user.chat_background_path)) {
      const result = relocate(user.chat_background_path, user.id);
      if (result) {
        db.prepare('UPDATE users SET chat_background_path = ? WHERE id = ?').run(result.newPath, user.id);
        moved.wallpaper += 1;
      }
    }
  }

  // Файлы, на которые не ссылается ни одна строка (загрузили, но сообщение так
  // и не отправили). Их тоже раскладываем по владельцам — иначе старые каталоги
  // не опустеют никогда, и «личная папка со всеми файлами» останется наполовину
  // правдой.
  for (const { prefix } of LEGACY_MAP) {
    const dir = path.join(UPLOADS_DIR, prefix.slice('/uploads/'.length).replace(/\/$/, ''));
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir)) {
      const legacyPath = `${prefix}${filename}`;
      // Уже перенесённое по строке из базы — не сирота: исходник ещё лежит на
      // месте (удаляем его последним шагом), и без этой проверки он посчитался
      // бы дважды.
      if (done.has(legacyPath)) continue;
      const owner = ownerFromFilename(filename);
      if (!owner) continue; // чужое имя — не наше дело, пусть лежит
      if (relocate(legacyPath, owner)) moved.orphans += 1;
    }
  }

  // Исходники удаляем последними и только те, что уже скопированы и на которые
  // в БД больше никто не ссылается.
  for (const [legacyPath, result] of done) {
    const stillUsed = db.prepare(`
      SELECT 1 FROM messages WHERE file_path = ? OR document_path = ?
      UNION ALL
      SELECT 1 FROM users WHERE avatar_path = ? OR chat_background_path = ?
    `).get(legacyPath, legacyPath, legacyPath, legacyPath);
    if (stillUsed) continue;
    try { fs.unlinkSync(result.legacyAbs); } catch { /* уже нет — и хорошо */ }
  }

  const total = moved.images + moved.files + moved.avatar + moved.wallpaper + moved.orphans;
  if (total) {
    console.log('[хранилище] перенесено в личные папки:', JSON.stringify(moved));
  }
  return moved;
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
  migrateLegacyUploads,
};
