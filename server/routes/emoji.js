const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const verifySuperAdmin = require('../middleware/verifySuperAdmin');

const router = express.Router();

const EMOJI_DIR = path.join(__dirname, '..', 'uploads', 'emoji');
fs.mkdirSync(EMOJI_DIR, { recursive: true });

// Смайлик показывается размером со строку текста — большего разрешения он не
// заслуживает, а вес важен: их на экране могут быть десятки.
const EMOJI_MAX_DIMENSION = 128;
const EMOJI_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const emojiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, EMOJI_ALLOWED_MIME.includes(file.mimetype)),
});

// Имя должно надёжно отличаться от обычного текста: в сообщении оно живёт как
// :name:, и рядом ходят и смайлики-двоеточия, и ссылки вида http://host:8080.
// Поэтому только латиница в нижнем регистре, цифры и подчёркивание, минимум
// две буквы — ":D" и ":8080" под это не подпадают.
const EMOJI_NAME_PATTERN = /^[a-z0-9_]{2,32}$/;

const normalizeName = (raw) => String(raw || '').trim().toLowerCase().replace(/^:|:$/g, '');

// Базовый юникодный эмодзи. Двоеточия вырезаются: фолбэк подставляется в тех
// самых местах, где код :name: и так не показать (уведомления, буфер обмена),
// и код внутри фолбэка вернул бы туда ровно то, от чего фолбэк избавляет.
const normalizeFallback = (raw) => String(raw || '').replace(/:/g, '').trim().slice(0, 16) || null;

// Служебный пак для картиночных смайликов из удалённых паков. Заводится по
// требованию и всегда выключен — его содержимое живёт только ради отрисовки
// старых сообщений, показывать его в панели выбора незачем.
const ARCHIVE_PACK_NAME = 'Архив смайликов';
function archivePackId() {
  const existing = db.prepare('SELECT id FROM emoji_packs WHERE name = ?').get(ARCHIVE_PACK_NAME);
  if (existing) return existing.id;
  const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_packs').get().p;
  return db.prepare('INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES (?, ?, 0, ?)')
    .run(ARCHIVE_PACK_NAME, nextPosition, Date.now()).lastInsertRowid;
}

// Один смайлик — короткая строка. Ограничение по длине именно символьное и с
// запасом: составные эмодзи (флаги, семьи, модификаторы тона кожи) занимают до
// десятка кодовых точек, но всё, что длиннее, — это уже не смайлик, а текст.
const MAX_EMOJI_LENGTH = 32;
const MAX_ITEMS_PER_PACK = 500;

function packsWithItems({ onlyEnabled }) {
  const packs = db.prepare(`
    SELECT id, name, position, enabled FROM emoji_packs
    ${onlyEnabled ? 'WHERE enabled = 1' : ''}
    ORDER BY position, id
  `).all();

  // Убранные смайлики в паках не показываются никому, включая панель админа:
  // вернуть их в выбор нельзя, а место они займут. Отрисовку старых сообщений
  // они переживают через отдельную ручку /catalog.
  const items = db.prepare(
    'SELECT id, pack_id, emoji, name, file_path, fallback_emoji FROM emoji_items WHERE retired = 0 ORDER BY position, id'
  ).all();
  const byPack = new Map();
  for (const item of items) {
    if (!byPack.has(item.pack_id)) byPack.set(item.pack_id, { emoji: [], custom: [] });
    const bucket = byPack.get(item.pack_id);
    // Картиночный элемент узнаётся по file_path, юникодный — по emoji.
    if (item.file_path && item.name) {
      bucket.custom.push({
        id: item.id,
        name: item.name,
        file_path: item.file_path,
        fallback: item.fallback_emoji || '',
      });
    } else if (item.emoji) {
      bucket.emoji.push(item.emoji);
    }
  }

  return packs.map((pack) => {
    const bucket = byPack.get(pack.id) || { emoji: [], custom: [] };
    return {
      id: pack.id,
      name: pack.name,
      position: pack.position,
      enabled: !!pack.enabled,
      // Поле emoji оставлено как было: на нём держатся и старая панель, и
      // уже выкаченные клиенты — их ломать нельзя.
      emoji: bucket.emoji,
      custom: bucket.custom,
    };
  });
}

function parseEmojiList(raw) {
  if (typeof raw === 'string') {
    // Из панели список приходит одной строкой — режем по пробелам и переводам
    // строки. Так его удобнее и вставлять, и править целиком.
    return raw.split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

function replaceItems(packId, list) {
  // Только юникодные: картиночные элементы правятся отдельными ручками, и
  // сохранение строки со смайликами не должно сносить загруженные файлы.
  db.prepare('DELETE FROM emoji_items WHERE pack_id = ? AND file_path IS NULL').run(packId);
  const insert = db.prepare('INSERT INTO emoji_items (pack_id, emoji, position) VALUES (?, ?, ?)');
  list.slice(0, MAX_ITEMS_PER_PACK)
    .filter((emoji) => emoji.length <= MAX_EMOJI_LENGTH)
    .forEach((emoji, index) => insert.run(packId, emoji, index));
}

// Каталог общий для всех — персонализации в нём нет, поэтому широковещательно.
// Клиент по этому событию перечитывает каталог и сбрасывает кэш панели выбора:
// иначе действие админа доходило бы до сидящего в чате человека только на
// следующем переподключении сокета.
const notifyEmojiChanged = (req) => {
  const io = req.app.get('io');
  if (io) io.emit('emoji_changed');
};

// Панель выбора смайликов у обычного пользователя — только включённые паки.
router.get('/', verifyToken, (req, res) => {
  try {
    res.json(packsWithItems({ onlyEnabled: true }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Каталог для ОТРИСОВКИ уже отправленных сообщений — это другой вопрос, чем
// «что можно вставить сейчас», и отвечать на него составом включённых паков
// нельзя: выключение пака или уборка смайлика тогда переводили бы всю старую
// переписку обратно в текст :name:. Поэтому здесь всё картиночное, что когда-
// либо существовало, независимо от enabled пака и retired элемента.
router.get('/catalog', verifyToken, (req, res) => {
  try {
    res.json(db.prepare(`
      SELECT name, file_path, fallback_emoji AS fallback
      FROM emoji_items
      WHERE name IS NOT NULL AND file_path IS NOT NULL
    `).all());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Управление паками: только супер-админ =====

router.get('/admin', verifySuperAdmin, (req, res) => {
  try {
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin', verifySuperAdmin, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Укажите название пака' });
    if (name.length > 60) return res.status(400).json({ error: 'Название слишком длинное' });

    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_packs').get().p;
    const packId = db.prepare(
      'INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES (?, ?, 1, ?)'
    ).run(name, nextPosition, Date.now()).lastInsertRowid;

    replaceItems(packId, parseEmojiList(req.body.emoji));
    notifyEmojiChanged(req);
    res.status(201).json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const pack = db.prepare('SELECT id FROM emoji_packs WHERE id = ?').get(id);
    if (!pack) return res.status(404).json({ error: 'Пак не найден' });

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Укажите название пака' });
      db.prepare('UPDATE emoji_packs SET name = ? WHERE id = ?').run(name.slice(0, 60), id);
    }

    if (req.body.enabled !== undefined) {
      db.prepare('UPDATE emoji_packs SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, id);
    }

    if (req.body.position !== undefined) {
      const position = Number(req.body.position);
      if (Number.isFinite(position)) {
        db.prepare('UPDATE emoji_packs SET position = ? WHERE id = ?').run(Math.floor(position), id);
      }
    }

    // Список смайликов заменяется целиком, а не патчится по одному: править
    // набор строкой в поле проще, чем гонять отдельные запросы на каждый знак.
    if (req.body.emoji !== undefined) {
      replaceItems(id, parseEmojiList(req.body.emoji));
    }

    notifyEmojiChanged(req);
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Загрузка кастомного смайлика картинкой. Имя задаётся при загрузке и дальше
// не меняется: оно уже уехало в тексты отправленных сообщений, и переименование
// превратило бы их в мёртвые ссылки.
router.post('/admin/:id/custom', verifySuperAdmin, (req, res) => {
  emojiUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });

    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT id FROM emoji_packs WHERE id = ?').get(packId);
    if (!pack) return res.status(404).json({ error: 'Пак не найден' });

    const name = normalizeName(req.body.name);
    if (!EMOJI_NAME_PATTERN.test(name)) {
      return res.status(400).json({ error: 'Имя: латиница, цифры и подчёркивание, от 2 до 32 символов' });
    }
    // Имя занято и убранным смайликом тоже: выдать его другой картинке значило
    // бы задним числом подменить картинку в уже отправленных сообщениях.
    const taken = db.prepare('SELECT retired FROM emoji_items WHERE name = ?').get(name);
    if (taken) {
      return res.status(409).json({
        error: taken.retired
          ? `Имя :${name}: занято ранее убранным смайликом`
          : `Смайлик :${name}: уже существует`,
      });
    }

    const count = db.prepare('SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND retired = 0').get(packId).c;
    if (count >= MAX_ITEMS_PER_PACK) return res.status(400).json({ error: 'В паке слишком много элементов' });

    try {
      const filename = `emoji_${name}_${crypto.randomBytes(4).toString('hex')}.webp`;
      await sharp(req.file.buffer, { animated: true })
        .resize(EMOJI_MAX_DIMENSION, EMOJI_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toFile(path.join(EMOJI_DIR, filename));

      const nextPosition = db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_items WHERE pack_id = ?'
      ).get(packId).p;
      // emoji объявлена NOT NULL ещё в исходной схеме — у картиночного
      // элемента её роль играет пустая строка, а вид определяется по file_path.
      db.prepare("INSERT INTO emoji_items (pack_id, emoji, name, file_path, fallback_emoji, position) VALUES (?, '', ?, ?, ?, ?)")
        .run(packId, name, `/uploads/emoji/${filename}`, normalizeFallback(req.body.fallback), nextPosition);

      notifyEmojiChanged(req);
      res.status(201).json(packsWithItems({ onlyEnabled: false }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Базовый юникодный эмодзи правится и после загрузки — в отличие от имени: имя
// уехало в тексты сообщений, а фолбэк нигде не хранится и подставляется на лету.
router.put('/admin/custom/:itemId', verifySuperAdmin, (req, res) => {
  try {
    const changed = db.prepare('UPDATE emoji_items SET fallback_emoji = ? WHERE id = ? AND file_path IS NOT NULL')
      .run(normalizeFallback(req.body.fallback), Number(req.params.itemId)).changes;
    if (!changed) return res.status(404).json({ error: 'Смайлик не найден' });

    notifyEmojiChanged(req);
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Замена картинки под тем же именем и кодом. В отличие от загрузки нового
// смайлика, это НЕ заводит новую строку: код :name: в старых сообщениях
// один и тот же, меняется только то, что за ним показывается — как правка
// опечатки в уже отправленной картинке, а не новый смайлик.
router.post('/admin/custom/:itemId/image', verifySuperAdmin, (req, res) => {
  emojiUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });

    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT name, file_path FROM emoji_items WHERE id = ? AND file_path IS NOT NULL').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    try {
      const filename = `emoji_${item.name}_${crypto.randomBytes(4).toString('hex')}.webp`;
      await sharp(req.file.buffer, { animated: true })
        .resize(EMOJI_MAX_DIMENSION, EMOJI_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toFile(path.join(EMOJI_DIR, filename));

      db.prepare('UPDATE emoji_items SET file_path = ? WHERE id = ?').run(`/uploads/emoji/${filename}`, itemId);

      // Старый файл больше ни на что не ссылается: код :name: разрешается в
      // file_path на лету, и старая переписка со следующего запроса каталога
      // покажет уже новую картинку. Оставлять прежний файл незачем — только
      // копится мусор на диске.
      const oldPath = path.join(__dirname, '..', item.file_path.replace(/^\/uploads\//, 'uploads/'));
      fs.unlink(oldPath, () => {});

      notifyEmojiChanged(req);
      res.json(packsWithItems({ onlyEnabled: false }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Порядок картиночных смайликов внутри пака — целиком по присланному списку id,
// как и со строкой юникодных: список задать проще, чем гонять запрос на каждую
// перестановку. Позиции переиспользуют то же поле, что и у юникодных элементов
// пака, но это не конфликтует: bucketing по виду элемента идёт уже на клиенте
// (и в packsWithItems), а сравниваются позиции только внутри одного вида.
router.put('/admin/:packId/custom/reorder', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.packId);
    const order = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    if (!order.length) return res.status(400).json({ error: 'Пустой порядок' });

    const belongs = db.prepare(
      'SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND file_path IS NOT NULL AND retired = 0 AND id IN (' +
      order.map(() => '?').join(',') + ')'
    ).get(packId, ...order).c;
    if (belongs !== order.length) return res.status(400).json({ error: 'Список не совпадает с содержимым пака' });

    const setPosition = db.prepare('UPDATE emoji_items SET position = ? WHERE id = ? AND pack_id = ?');
    const applyOrder = db.transaction(() => {
      order.forEach((id, index) => setPosition.run(index, id, packId));
    });
    applyOrder();

    notifyEmojiChanged(req);
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Уборка кастомного смайлика. Ни файл с диска, ни строка из БД не удаляются:
// код :name: уже уехал в тексты отправленных сообщений, и без строки их стало
// бы не по чему отрисовать. Смайлик пропадает из панели выбора, старая
// переписка остаётся как была.
router.delete('/admin/custom/:itemId', verifySuperAdmin, (req, res) => {
  try {
    db.prepare('UPDATE emoji_items SET retired = 1 WHERE id = ? AND file_path IS NOT NULL').run(Number(req.params.itemId));
    notifyEmojiChanged(req);
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.id);
    // Архивный пак не удаляется: в выдаче он выглядит пустым (убранные элементы
    // не показываются), и удалить его — соблазн, а каскад унёс бы вместе с ним
    // ровно те картинки, ради сохранения которых он и заведён.
    const pack = db.prepare('SELECT name FROM emoji_packs WHERE id = ?').get(packId);
    if (pack?.name === ARCHIVE_PACK_NAME) {
      return res.status(400).json({ error: 'Архив нельзя удалить: в нём хранятся смайлики из старых сообщений' });
    }

    // Картиночные элементы пака пережидают его удаление в служебном паке: на
    // emoji_items висит ON DELETE CASCADE, и без переноса они исчезли бы вместе
    // с паком, а с ними — и отрисовка всех сообщений с их кодами. Юникодные
    // уходят каскадом как раньше: их отрисовка от БД не зависит.
    const custom = db.prepare(
      'SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND file_path IS NOT NULL'
    ).get(packId).c;
    if (custom) {
      db.prepare('UPDATE emoji_items SET pack_id = ?, retired = 1 WHERE pack_id = ? AND file_path IS NOT NULL')
        .run(archivePackId(), packId);
    }
    db.prepare('DELETE FROM emoji_packs WHERE id = ?').run(packId);
    notifyEmojiChanged(req);
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
