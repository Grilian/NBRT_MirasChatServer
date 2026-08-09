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
const router = express.Router();

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
      const { isOpaque } = await sharp(req.file.buffer).stats();
      const suffix = isOpaque ? '' : '_a';
      const filename = `msg_${req.userId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${suffix}.webp`;
      const outputPath = path.join(CHAT_IMAGES_DIR, filename);

      const image = sharp(req.file.buffer).rotate();
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
      res.status(500).json({ error: e.message });
    }
  });
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
      SELECT m.chat_id, m.text, m.file_path, m.created_at, m.deleted
      FROM messages m
      INNER JOIN (
        SELECT chat_id, MAX(id) AS max_id
        FROM messages
        WHERE NOT EXISTS (
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
        created_at: row.created_at,
      };
    });

    res.json(result);
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

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    // Постраничная подгрузка "вверх" идёт по id последнего известного клиенту
    // сообщения, а не по offset. С offset докрутка истории разъезжалась:
    // пока человек читает, в чат приходят новые сообщения, все смещаются на
    // одну позицию, и следующая страница либо повторяла уже показанное, либо
    // перепрыгивала через непоказанное. Курсор по id от таких сдвигов не
    // зависит. offset ещё принимаем — на нём сидят уже собранные мобильные
    // сборки, которые обновляются не одновременно с сервером.
    const before = parseInt(req.query.before);
    const offset = parseInt(req.query.offset) || 0;
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
          SELECT m.id, m.text, m.file_path, m.file_width, m.file_height, m.sender_id, m.created_at, m.status, m.edited_at, m.deleted, m.read_at, u.username, u.display_name,
                 m.reply_to_id, m.forwarded_from_name, m.forwarded_from_chat,
                 rm.text AS reply_to_text, rm.file_path AS reply_to_file, rm.deleted AS reply_to_deleted,
                 COALESCE(ru.display_name, ru.username) AS reply_to_author,
                 (r.message_id IS NOT NULL) AS read_by_me${readCountColumn}
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          LEFT JOIN messages rm ON rm.id = m.reply_to_id
          LEFT JOIN users ru ON ru.id = rm.sender_id
          LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
          WHERE m.chat_id = ? AND m.id < ?
            AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
          ORDER BY m.id DESC
          LIMIT ?
        `).all(req.userId, chatId, before, req.userId, limit)
      : db.prepare(`
          SELECT m.id, m.text, m.file_path, m.file_width, m.file_height, m.sender_id, m.created_at, m.status, m.edited_at, m.deleted, m.read_at, u.username, u.display_name,
                 m.reply_to_id, m.forwarded_from_name, m.forwarded_from_chat,
                 rm.text AS reply_to_text, rm.file_path AS reply_to_file, rm.deleted AS reply_to_deleted,
                 COALESCE(ru.display_name, ru.username) AS reply_to_author,
                 (r.message_id IS NOT NULL) AS read_by_me${readCountColumn}
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          LEFT JOIN messages rm ON rm.id = m.reply_to_id
          LEFT JOIN users ru ON ru.id = rm.sender_id
          LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
          WHERE m.chat_id = ?
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
      }
      // То же и для цитаты: ответить успели, а исходное потом удалили —
      // содержимое не должно уехать наружу окольным путём, через ответ.
      if (m.reply_to_deleted) {
        m.reply_to_text = '';
        m.reply_to_file = null;
      }
    }

    // Опрос персонализирован: user_option_ids и, при открытых именах,
    // участники зависят от запрашивающего. Поэтому дополняем историю только
    // после проверки доступа к чату и именно для req.userId.
    attachPollsToMessages(messages, req.userId);

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
          WHERE m.chat_id = ? AND m.id < ?
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
