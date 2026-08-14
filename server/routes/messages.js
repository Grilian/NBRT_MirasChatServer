const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const { isParticipant } = require('../services/chatParticipants');
const { reactionsForMessages } = require('../services/reactions');
const { attachPollsToMessages } = require('../services/polls');
const { touchRecentChat, listRecentChats } = require('../services/recentChats');
const {
  ThreadError,
  attachThreadSummaries,
  getThread,
  listThreadsForUser,
  markThreadRead,
  rootForUser,
  threadSummary,
} = require('../services/threads');
const router = express.Router();

// Последние открытые переписки синхронизируются между платформами. В список
// попадают только чаты, куда пользователь уже отправлял сообщения; личное
// «Избранное» допускается как отдельный встроенный чат.
router.get('/meta/recent', verifyToken, (req, res) => {
  try {
    res.json(listRecentChats(req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/meta/recent/:chatId', verifyToken, (req, res) => {
  try {
    const chatId = req.params.chatId;
    if (!isParticipant(chatId, req.userId)) {
      return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    touchRecentChat(req.userId, chatId);
    const recent = listRecentChats(req.userId);
    req.app.get('io')?.to(`user:${req.userId}`).emit('recent_chats_changed', recent);
    res.json(recent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Канал-объявление: в нём считаем «просмотрено» (см. историю чата ниже).
// Проверяем по chat_id, чтобы не тащить сюда весь routes/groups.js — нужен
// один флаг, а не права на запись.
function isAnnouncementChat(chatId) {
  const match = String(chatId).match(/^group_(\d+)$/);
  if (!match) return false;
  const group = db.prepare('SELECT announcements_only FROM chat_groups WHERE id = ?').get(Number(match[1]));
  return !!(group && group.announcements_only);
}

const CHAT_IMAGES_DIR = path.join(__dirname, '..', 'uploads', 'chat-images');
fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });

const CHAT_IMAGE_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// Длинная сторона — контентная картинка, не аватар: должно остаться читаемо
// на весь экран телефона, но без смысла тащить оригинал в 12 мегапикселей
// с камеры ради превью в чате.
const CHAT_IMAGE_MAX_DIMENSION = 1600;
const CHAT_IMAGE_QUALITY = 82;

const chatImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, CHAT_IMAGE_ALLOWED_MIME.includes(file.mimetype)),
});

// Отправка сообщения и загрузка файла — два разных запроса: сначала грузим
// картинку и получаем путь, потом отправляем chat_message по сокету с этим
// путём (см. server/index.js). Поэтому сокет обязан сам проверить, что путь
// похож на то, что мог выдать именно этот эндпоинт, а не что попало от
// клиента, — регэксп ниже и есть эта проверка.
const CHAT_IMAGE_PATH_PATTERN = /^\/uploads\/chat-images\/[a-z0-9_-]+\.webp$/;

function isValidChatImagePath(filePath) {
  if (typeof filePath !== 'string' || !CHAT_IMAGE_PATH_PATTERN.test(filePath)) return false;
  const abs = path.join(__dirname, '..', filePath.replace(/^\//, ''));
  return fs.existsSync(abs);
}

// ===== Файлы (документы, архивы) =====
//
// В отличие от картинки, файл НЕ перекодируется: он должен дойти байт в байт,
// иначе это уже не тот файл, который отправляли. Поэтому и путь другой, и
// расширение сохраняется, и MIME берётся тот, что прислал клиент (для показа
// значка, не для доверия).
const CHAT_FILES_DIR = path.join(__dirname, '..', 'uploads', 'chat-files');
fs.mkdirSync(CHAT_FILES_DIR, { recursive: true });

/**
 * Предел размера файла. Ровно 50 МБ по требованию; при превышении человек
 * должен увидеть не «ошибка загрузки», а объяснение — система в тестовом
 * режиме. Клиент проверяет размер до отправки (чтобы не гнать 200 МБ впустую),
 * но проверка обязана быть и здесь: клиентскую обойти тривиально.
 */
const CHAT_FILE_MAX_BYTES = 50 * 1024 * 1024;
const CHAT_FILE_TOO_LARGE_MESSAGE =
  'Система работает в тестовом режиме, пока большие файлы отправлять нельзя. '
  + 'Предельный размер — 50 МБ.';

const chatFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_FILE_MAX_BYTES },
});

// Имя на диске: только латиница, цифры и точка-дефис-подчёркивание, плюс
// случайная часть. Оригинальное имя человека хранится в БД отдельно и на
// файловую систему не влияет — иначе кириллица, пробелы и «../» в имени
// превращались бы в проблему на каждом шаге.
const CHAT_FILE_PATH_PATTERN = /^\/uploads\/chat-files\/[a-zA-Z0-9_.-]+$/;

function isValidChatFilePath(filePath) {
  if (typeof filePath !== 'string' || !CHAT_FILE_PATH_PATTERN.test(filePath)) return false;
  // Отдельно от регэкспа: `..` в имени под шаблон не подходит, но проверка
  // дешёвая, а цена промаха — чтение чужого файла с диска.
  if (filePath.includes('..')) return false;
  const abs = path.join(__dirname, '..', filePath.replace(/^\//, ''));
  return fs.existsSync(abs);
}

/** Расширение из имени файла — только оно и переезжает на диск. */
function safeExtension(originalName) {
  const match = /\.([a-zA-Z0-9]{1,12})$/.exec(String(originalName || ''));
  return match ? `.${match[1].toLowerCase()}` : '';
}

/**
 * Имя файла из multipart-формы приходит РАЗОБРАННЫМ КАК LATIN-1.
 *
 * Так устроен busboy под multer: заголовок `filename` он читает побайтово и
 * складывает в строку по одному символу на байт. Для «report.pdf» разницы нет,
 * а «смета.pdf» превращается в «ÑÐ¼ÐµÑ‚Ð°.pdf» — и именно это имя увидел бы
 * получатель. Собираем байты обратно и читаем их как UTF-8.
 *
 * Если байты не были валидным UTF-8 (файл действительно назван латиницей с
 * диакритикой в другой кодировке), декодирование даст U+FFFD — тогда лучше
 * оставить исходную строку, чем показать вопросительные знаки.
 */
function decodeMultipartName(raw) {
  const value = String(raw || '');
  const restored = Buffer.from(value, 'latin1').toString('utf8');
  return restored.includes('�') ? value : restored;
}

router.post('/upload-file', verifyToken, (req, res) => {
  chatFileUpload.single('file')(req, res, (err) => {
    if (err) {
      // multer сообщает о превышении лимита кодом, а не текстом: подменяем
      // его человеческим объяснением, которое требуется по условию.
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: CHAT_FILE_TOO_LARGE_MESSAGE, code: 'file_too_large' });
      }
      return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });

    try {
      const filename = `doc_${req.userId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
        + safeExtension(decodeMultipartName(req.file.originalname));
      fs.writeFileSync(path.join(CHAT_FILES_DIR, filename), req.file.buffer);

      // Имя приходит от клиента и показывается другим людям — режем длину и
      // управляющие символы, иначе одна строка ломает вёрстку карточки.
      const originalName = decodeMultipartName(req.file.originalname || 'файл')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f]/g, '')
        .slice(0, 200) || 'файл';

      res.json({
        file_path: `/uploads/chat-files/${filename}`,
        name: originalName,
        size: req.file.size,
        mime: req.file.mimetype || 'application/octet-stream',
      });
    } catch (e) {
      console.error('[upload-file] не удалось сохранить файл:', e.message);
      res.status(500).json({ error: 'Не удалось сохранить файл' });
    }
  });
});

// Грузим и сразу пережимаем в webp — единый формат на выходе проще отдавать
// и меньше весит, чем исходные jpeg/png с телефонных камер.
router.post('/upload-image', verifyToken, (req, res) => {
  chatImageUpload.single('image')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });
    }

    // Недописанный файл — не повод отказать в отправке.
    //
    // На части устройств (ловили на Vivo V21e) «сделал скриншот и сразу
    // поделился» отдаёт файл раньше, чем система дописала его на диск: до
    // сервера доезжает обрезанный хвост, sharp по умолчанию считает это
    // фатальной ошибкой, и отправка вставала намертво. То же изображение,
    // открытое и пересохранённое в редакторе, уходило сразу — им и опознали
    // причину. failOn: 'none' велит разобрать столько, сколько есть: в худшем
    // случае у кадра будет смазана нижняя полоса, и это несравнимо лучше, чем
    // «картинка не отправляется, и сделать с ней ничего нельзя».
    const decode = (buffer) => sharp(buffer, { failOn: 'none' });

    try {
      // Прозрачность нужна клиенту, чтобы не подкладывать под наклейку плашку
      // и не обводить её рамкой. Метку кладём В ИМЯ ФАЙЛА (суффикс `_a`), а не
      // отдельной колонкой: иначе флаг пришлось бы протаскивать через сокет,
      // вставку сообщения и все три выдачи истории ради одного бита, который
      // и так однозначно определяется самим файлом. Старые картинки суффикса
      // не имеют и считаются непрозрачными — это верно, они такими и были.
      // ВАЖНО: спрашиваем не про наличие альфа-канала, а про то, есть ли в нём
      // хоть один прозрачный пиксель. Скриншоты и любой PNG из canvas почти
      // всегда идут с альфа-каналом, будучи полностью непрозрачными, — по
      // hasAlpha рамку потеряли бы почти все картинки.
      // Статистика читает КАЖДЫЙ пиксель, и на обрезанном файле спотыкается
      // чаще самой перекодировки. Прозрачность — деталь оформления: не смогли
      // выяснить, считаем картинку непрозрачной (как и все старые) и всё равно
      // отправляем, вместо того чтобы ронять из-за неё всю загрузку.
      let isOpaque = true;
      try {
        ({ isOpaque } = await decode(req.file.buffer).stats());
      } catch {
        isOpaque = true;
      }
      const suffix = isOpaque ? '' : '_a';
      const filename = `msg_${req.userId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${suffix}.webp`;
      const outputPath = path.join(CHAT_IMAGES_DIR, filename);

      const image = decode(req.file.buffer).rotate();
      const resized = image.resize(CHAT_IMAGE_MAX_DIMENSION, CHAT_IMAGE_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
      const info = await resized.webp({ quality: CHAT_IMAGE_QUALITY }).toFile(outputPath);

      res.json({
        file_path: `/uploads/chat-images/${filename}`,
        file_width: info.width,
        file_height: info.height,
      });
    } catch (e) {
      // Файл дошёл, но изображением не оказался вовсе — это отказ клиенту
      // (400), а не поломка сервера: повторять такую отправку бессмысленно, и
      // человек должен увидеть внятную причину, а не «ошибка 500».
      console.error('[upload-image] не удалось обработать изображение:', e.message);
      res.status(400).json({ error: 'Не удалось обработать изображение. Попробуйте отправить другой файл.' });
    }
  });
});

// Ветка читается отдельно от основной истории: её ответы не должны попадать в
// обычную пагинацию чата и отмечаться прочитанными одним открытием разговора.
router.get('/threads', verifyToken, (req, res) => {
  try {
    res.json(listThreadsForUser(req.userId, req.query.limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/threads/:rootId', verifyToken, (req, res) => {
  try {
    res.json(getThread(req.params.rootId, req.userId));
  } catch (error) {
    const status = error instanceof ThreadError ? error.status : 500;
    res.status(status).json({ error: error.code || error.message });
  }
});

router.get('/threads/:rootId/summary', verifyToken, (req, res) => {
  try {
    rootForUser(req.params.rootId, req.userId);
    res.json(threadSummary(req.params.rootId, req.userId));
  } catch (error) {
    const status = error instanceof ThreadError ? error.status : 500;
    res.status(status).json({ error: error.code || error.message });
  }
});

router.post('/threads/:rootId/read', verifyToken, (req, res) => {
  try {
    const result = markThreadRead(req.params.rootId, req.userId);
    const io = req.app.get('io');
    io?.to(`user:${req.userId}`).emit('thread_read', {
      root_id: Number(req.params.rootId),
      message_ids: result.messageIds,
      summary: result.summary,
    });
    res.json({ ok: true, message_ids: result.messageIds, summary: result.summary });
  } catch (error) {
    const status = error instanceof ThreadError ? error.status : 500;
    res.status(status).json({ error: error.code || error.message });
  }
});

// Последнее сообщение по каждому chat_id — для превью в списке диалогов.
// Раньше выборка не была сужена до "чатов текущего пользователя" — chat_id
// (chat_<a>_<b>, miras_admin_<login>_<id>) детерминированно вычисляется из
// пары id, так что любой мог узнать превью переписки чужих людей, просто
// подобрав их id. Фильтруем по участию текущего пользователя.
router.get('/meta/last', verifyToken, (req, res) => {
  try {
    // «Последнее» считаем персонально: сообщение, скрытое этим человеком у
    // себя, не должно оставаться превью его чата — там встаёт предыдущее.
    const rows = db.prepare(`
      SELECT m.chat_id, m.text, m.file_path, m.sticker_id, m.sticker_fallback, m.document_name, m.created_at, m.deleted
      FROM messages m
      INNER JOIN (
        SELECT chat_id, MAX(id) AS max_id
        FROM messages
        WHERE thread_root_id IS NULL
          AND NOT EXISTS (
          SELECT 1 FROM message_hidden h WHERE h.message_id = messages.id AND h.user_id = ?
        )
        GROUP BY chat_id
      ) latest ON latest.chat_id = m.chat_id AND latest.max_id = m.id
    `).all(req.userId);

    const result = {};
    rows.forEach(row => {
      if (!isParticipant(row.chat_id, req.userId)) return;
      // Удалённое сообщение по-прежнему хранится целиком (обязательство по
      // закону), но наружу — даже в превью последнего сообщения — из него
      // ничего не должно попасть.
      result[row.chat_id] = {
        chat_id: row.chat_id,
        text: row.deleted ? '' : row.text,
        file_path: row.deleted ? null : row.file_path,
        sticker_id: row.deleted ? null : row.sticker_id,
        sticker_fallback: row.deleted ? null : row.sticker_fallback,
        document_name: row.deleted ? null : row.document_name,
        created_at: row.created_at,
      };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Вложения переписки: «Медиа», «Файлы», «Ссылки» в карточке =====
//
// Отдельная выдача, а не фильтрация уже загруженной истории на клиенте:
// история грузится страницами по 50 сообщений, и «все картинки за три года»
// в ней просто нет. Здесь же идёт выборка сразу по нужному признаку.
//
// Ссылки НЕ хранятся отдельной таблицей: они и так лежат в тексте сообщений,
// а отдельное хранилище пришлось бы наполнять миграцией по всему архиву и
// держать в согласии при каждой правке текста. Дешевле сузить выборку в SQL
// (LIKE по http/www) и разобрать найденное здесь — тем же разбором, что и на
// клиенте при отрисовке.
const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** Хвостовая пунктуация в ссылку не входит: «см. http://a.ru.» — точка внешняя. */
function trimLinkTail(value) {
  let end = value.length;
  while (end > 0 && '.,!?;:)'.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

const ATTACHMENT_KINDS = ['media', 'files', 'links'];

router.get('/:chatId/attachments', verifyToken, (req, res) => {
  try {
    const chatId = req.params.chatId;
    if (!isParticipant(chatId, req.userId)) {
      return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    const kind = ATTACHMENT_KINDS.includes(req.query.kind) ? req.query.kind : 'media';
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 200)
      : 60;

    // Удалённое и скрытое лично этим человеком не показываем — те же правила,
    // что и в самой ленте: вложение не должно пережить своё сообщение.
    const common = `
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = ? AND m.deleted = 0
        AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
    `;

    if (kind === 'media') {
      const rows = db.prepare(`
        SELECT m.id, m.file_path, m.file_width, m.file_height, m.created_at,
               m.sender_id, u.username, u.display_name
        ${common} AND m.file_path IS NOT NULL
        ORDER BY m.id DESC LIMIT ?
      `).all(chatId, req.userId, limit);
      return res.json({ kind, items: rows });
    }

    if (kind === 'files') {
      const rows = db.prepare(`
        SELECT m.id, m.document_path, m.document_name, m.document_size, m.document_mime,
               m.created_at, m.sender_id, u.username, u.display_name
        ${common} AND m.document_path IS NOT NULL
        ORDER BY m.id DESC LIMIT ?
      `).all(chatId, req.userId, limit);
      return res.json({ kind, items: rows });
    }

    // Ссылки: сужаем в SQL, разбираем в JS. Одно сообщение может нести
    // несколько ссылок — каждая идёт отдельной строкой списка.
    const rows = db.prepare(`
      SELECT m.id, m.text, m.created_at, m.sender_id, u.username, u.display_name
      ${common} AND m.text IS NOT NULL AND m.text != ''
        AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%' OR m.text LIKE '%www.%')
      ORDER BY m.id DESC LIMIT ?
    `).all(chatId, req.userId, limit);

    const items = [];
    const seen = new Set();
    for (const row of rows) {
      LINK_PATTERN.lastIndex = 0;
      let match = LINK_PATTERN.exec(row.text);
      while (match) {
        const url = trimLinkTail(match[0]);
        // Один и тот же адрес, отправленный трижды, — одна строка в списке:
        // это справочник ссылок чата, а не лог отправок.
        if (url && !seen.has(url)) {
          seen.add(url);
          items.push({
            message_id: row.id,
            url,
            href: /^https?:\/\//i.test(url) ? url : `https://${url}`,
            created_at: row.created_at,
            sender_id: row.sender_id,
            username: row.username,
            display_name: row.display_name,
          });
        }
        match = LINK_PATTERN.exec(row.text);
      }
    }

    res.json({ kind, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить историю чата с пагинацией
router.get('/:chatId', verifyToken, (req, res) => {
  try {
    const chatId = req.params.chatId;

    // Раньше кто угодно с валидным токеном мог прочитать историю ЛЮБОГО
    // чужого 1:1 чата, просто зная/подобрав пару id в chat_<a>_<b> — сервер
    // не проверял, что запрашивающий сам участник.
    if (!isParticipant(chatId, req.userId)) {
      return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 50;

    // Постраничная подгрузка "вверх" идёт по id последнего известного клиенту
    // сообщения, а не по offset. С offset докрутка истории разъезжалась:
    // пока человек читает, в чат приходят новые сообщения, все смещаются на
    // одну позицию, и следующая страница либо повторяла уже показанное, либо
    // перепрыгивала через непоказанное. Курсор по id от таких сдвигов не
    // зависит. offset ещё принимаем — на нём сидят уже собранные мобильные
    // сборки, которые обновляются не одновременно с сервером.
    const before = Number.parseInt(req.query.before, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const offset = Number.isInteger(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    const useCursor = Number.isInteger(before);

    // ORDER BY id, а не created_at: у сообщений, записанных в одну секунду,
    // created_at совпадает (точность SQLite CURRENT_TIMESTAMP — секунда), и
    // порядок внутри такой пары был неопределённым — при перезагрузке чата
    // соседние реплики могли меняться местами.
    // read_by_me — личная отметка о прочтении из message_reads. Нужна именно в
    // общих чатах и группах: там m.status значит лишь «прочитано хоть кем-то»,
    // и клиент, отбирая по нему непрочитанное, пропускал сообщения, которые
    // прочитал кто-то другой, — они навсегда оставались непрочитанными лично
    // для этого человека, и бейдж возвращался при каждом обновлении счётчиков.
    // Счётчик «просмотрено» — только в каналах-объявлениях: там сообщение
    // пишут для всех и важно, сколько человек его увидело. В обычной переписке
    // это лишний подзапрос на каждое сообщение и лишняя цифра в интерфейсе.
    // message_reads.PRIMARY KEY начинается с message_id, так что COUNT идёт по
    // индексу, а не сканом.
    const readCountColumn = isAnnouncementChat(chatId)
      ? ', (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count'
      : '';

    const messages = useCursor
      ? db.prepare(`
          SELECT m.id, m.text, m.file_path, m.file_width, m.file_height, m.sticker_id, m.sticker_fallback,
                 m.document_path, m.document_name, m.document_size, m.document_mime, m.sender_id, m.created_at, m.status, m.edited_at, m.deleted, m.read_at, u.username, u.display_name,
                 m.reply_to_id, m.forwarded_from_name, m.forwarded_from_chat, m.client_message_id,
                 rm.text AS reply_to_text, rm.file_path AS reply_to_file, rm.sticker_fallback AS reply_to_sticker_fallback, rm.deleted AS reply_to_deleted,
                 COALESCE(ru.display_name, ru.username) AS reply_to_author,
                 (r.message_id IS NOT NULL) AS read_by_me${readCountColumn}
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          LEFT JOIN messages rm ON rm.id = m.reply_to_id
          LEFT JOIN users ru ON ru.id = rm.sender_id
          LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
          WHERE m.chat_id = ? AND m.id < ? AND m.thread_root_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          ORDER BY m.id DESC
          LIMIT ?
        `).all(req.userId, chatId, before, req.userId, limit)
      : db.prepare(`
          SELECT m.id, m.text, m.file_path, m.file_width, m.file_height, m.sticker_id, m.sticker_fallback,
                 m.document_path, m.document_name, m.document_size, m.document_mime, m.sender_id, m.created_at, m.status, m.edited_at, m.deleted, m.read_at, u.username, u.display_name,
                 m.reply_to_id, m.forwarded_from_name, m.forwarded_from_chat, m.client_message_id,
                 rm.text AS reply_to_text, rm.file_path AS reply_to_file, rm.sticker_fallback AS reply_to_sticker_fallback, rm.deleted AS reply_to_deleted,
                 COALESCE(ru.display_name, ru.username) AS reply_to_author,
                 (r.message_id IS NOT NULL) AS read_by_me${readCountColumn}
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          LEFT JOIN messages rm ON rm.id = m.reply_to_id
          LEFT JOIN users ru ON ru.id = rm.sender_id
          LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
          WHERE m.chat_id = ? AND m.thread_root_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          ORDER BY m.id DESC
          LIMIT ? OFFSET ?
        `).all(req.userId, chatId, req.userId, limit, offset);

    // Переворачиваем чтобы старые были в начале
    messages.reverse();

    // Удалённое сообщение хранится в БД целиком (обязательство по закону —
    // быть готовыми предоставить переписку по требованию), но клиенту из
    // него уходит только сам факт (id/deleted), без text/file_path — так
    // содержимое не оказывается в ответе API вообще, даже если интерфейс
    // потом сам решает не показывать такие строки.
    for (const m of messages) {
      if (m.deleted) {
        m.text = '';
        m.file_path = null;
        m.file_width = null;
        m.file_height = null;
        m.sticker_id = null;
        m.sticker_fallback = null;
        m.document_path = null;
        m.document_name = null;
        m.document_size = null;
        m.document_mime = null;
      }
      // То же и для цитаты: ответить успели, а исходное потом удалили —
      // содержимое не должно уехать наружу окольным путём, через ответ.
      if (m.reply_to_deleted) {
        m.reply_to_text = '';
        m.reply_to_file = null;
        m.reply_to_sticker_fallback = null;
      }
    }

    // Опрос персонализирован: user_option_ids и, при открытых именах,
    // участники зависят от запрашивающего. Поэтому дополняем историю только
    // после проверки доступа к чату и именно для req.userId.
    attachPollsToMessages(messages, req.userId);
    attachThreadSummaries(messages, req.userId);

    // Реакции — одним запросом на всю страницу, а не по запросу на сообщение.
    const reactionsByMessage = reactionsForMessages(messages.map((m) => m.id));
    for (const m of messages) m.reactions = reactionsByMessage[m.id] || [];

    // Есть ли что-то ещё выше самого старого из отданных. Скрытые лично этим
    // человеком не считаем: иначе «загрузить ещё» обещало бы страницу, которая
    // после фильтрации окажется пустой, и прокрутка вверх упиралась бы в
    // бесконечную «Загрузку…».
    const oldestId = messages.length ? messages[0].id : null;
    const hasMore = oldestId === null
      ? false
      : db.prepare(`
          SELECT 1 FROM messages m
          WHERE m.chat_id = ? AND m.id < ? AND m.thread_root_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          LIMIT 1
        `).get(chatId, oldestId, req.userId) !== undefined;

    res.json({ messages, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.isValidChatImagePath = isValidChatImagePath;
module.exports.isValidChatFilePath = isValidChatFilePath;
module.exports.CHAT_FILE_MAX_BYTES = CHAT_FILE_MAX_BYTES;
module.exports.CHAT_FILE_TOO_LARGE_MESSAGE = CHAT_FILE_TOO_LARGE_MESSAGE;
