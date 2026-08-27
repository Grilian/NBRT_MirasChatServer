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

// Зеркало server/routes/emoji.js, но проще: стикер не печатается кодом внутри
// текста (это самостоятельное сообщение, см. CLAUDE.md), значит не нужны ни
// глобально уникальное имя, ни разбор шорткодов, ни отдельная "уборка вместо
// удаления" ради занятого имени — имени просто нет.

const STICKER_DIR = path.join(__dirname, '..', 'uploads', 'stickers');
fs.mkdirSync(STICKER_DIR, { recursive: true });

// Стикер крупнее смайлика — это самостоятельная картинка в ленте, а не значок
// внутри строки текста.
const STICKER_MAX_DIMENSION = 512;
const STICKER_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_EMOJI_LENGTH = 32;
const MAX_ITEMS_PER_PACK = 500;

const stickerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, STICKER_ALLOWED_MIME.includes(file.mimetype)),
});

const normalizeEmoji = (raw) => String(raw || '').trim().slice(0, MAX_EMOJI_LENGTH);

// У стикера ровно один файл: если исходник анимированный (GIF/WebP), sharp
// сохраняет все его кадры в итоговый WebP; если статичный — итог остаётся
// статичным. Отдельной static/animated-пары, как у смайликов, здесь нет.
// Обложку пака намеренно оставляем статичной: это метаданные набора, не стикер.
async function saveStickerImage(buffer, prefix, { preserveAnimation = false } = {}) {
  const filename = `${prefix}_${crypto.randomBytes(6).toString('hex')}.webp`;
  await sharp(buffer, preserveAnimation ? { animated: true } : {})
    .resize(STICKER_MAX_DIMENSION, STICKER_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toFile(path.join(STICKER_DIR, filename));
  return `/uploads/stickers/${filename}`;
}

const unlinkStickerFile = (filePath) => {
  if (!filePath) return;
  const onDisk = path.join(__dirname, '..', String(filePath).replace(/^\/uploads\//, 'uploads/'));
  fs.unlink(onDisk, () => {});
};

// Сколько отправленных сообщений ссылаются на этот стикер — спрашивается
// перед удалением, тем же способом, что usageCount у смайликов.
const usageCount = (itemId) => db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sticker_id = ?').get(itemId).c;

// Служебный пак для стикеров из удалённых паков — то же самое, что «Архив
// смайликов»: заводится по требованию, выключен, существует только ради
// отрисовки старых сообщений.
const ARCHIVE_PACK_NAME = 'Архив стикеров';
function archivePackId() {
  const existing = db.prepare('SELECT id FROM sticker_packs WHERE name = ?').get(ARCHIVE_PACK_NAME);
  if (existing) return existing.id;
  const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sticker_packs').get().p;
  return db.prepare('INSERT INTO sticker_packs (name, position, enabled, created_at) VALUES (?, ?, 0, ?)')
    .run(ARCHIVE_PACK_NAME, nextPosition, Date.now()).lastInsertRowid;
}

function packsWithItems({ onlyEnabled, includeRetired = false }) {
  const packs = db.prepare(`
    SELECT id, name, cover_path, position, enabled FROM sticker_packs
    ${onlyEnabled ? 'WHERE enabled = 1' : ''}
    ORDER BY position, id
  `).all();

  const items = db.prepare(
    `SELECT id, pack_id, file_path, emoji, retired, position
     FROM sticker_items ${includeRetired ? '' : 'WHERE retired = 0'} ORDER BY position, id`
  ).all();
  const byPack = new Map();
  for (const item of items) {
    if (!byPack.has(item.pack_id)) byPack.set(item.pack_id, []);
    byPack.get(item.pack_id).push({
      id: item.id,
      file_path: item.file_path,
      emoji: item.emoji,
      ...(includeRetired ? { retired: !!item.retired } : {}),
    });
  }

  return packs.map((pack) => {
    const items = byPack.get(pack.id) || [];
    return {
      id: pack.id,
      name: pack.name,
      // Явной обложки может не быть — тогда клиент сам берёт первую картинку
      // набора; здесь просто отдаём то, что есть, включая null.
      cover_path: pack.cover_path || (items[0]?.file_path ?? null),
      position: pack.position,
      enabled: !!pack.enabled,
      items,
    };
  });
}

const adminPacks = () => packsWithItems({ onlyEnabled: false, includeRetired: true });

// Каталог общий для всех — широковещательно, тем же способом, что у смайликов.
const notifyStickersChanged = (req) => {
  const io = req.app.get('io');
  if (io) io.emit('stickers_changed');
};

// Пикер у обычного пользователя — только включённые паки, без спрятанных
// элементов.
router.get('/', verifyToken, (req, res) => {
  try {
    res.json(packsWithItems({ onlyEnabled: true }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Каталог для ОТРИСОВКИ уже отправленных сообщений — все элементы, что
// когда-либо существовали, независимо от enabled пака и retired элемента.
// Тот же принцип, что у /emoji/catalog: выключение пака не должно превращать
// старые сообщения в мусор.
router.get('/catalog', verifyToken, (req, res) => {
  try {
    res.json(db.prepare(`
      SELECT id, file_path, emoji
      FROM sticker_items
    `).all());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Управление паками: только супер-админ =====

router.get('/admin', verifySuperAdmin, (req, res) => {
  try {
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin', verifySuperAdmin, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Укажите название пака' });
    if (name.length > 60) return res.status(400).json({ error: 'Название слишком длинное' });

    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sticker_packs').get().p;
    db.prepare(
      'INSERT INTO sticker_packs (name, position, enabled, created_at) VALUES (?, ?, 1, ?)'
    ).run(name, nextPosition, Date.now());

    notifyStickersChanged(req);
    res.status(201).json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Порядок паков задаётся целиком: так две параллельные перестановки не оставят
// одинаковые position и клиент всегда получит ровно тот порядок вкладок,
// который видит администратор после drag-and-drop.
router.put('/admin/reorder', verifySuperAdmin, (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    const existing = db.prepare('SELECT id FROM sticker_packs ORDER BY position, id').all().map((row) => row.id);
    const unique = new Set(order);
    if (order.length !== existing.length || unique.size !== order.length || order.some((id) => !existing.includes(id))) {
      return res.status(400).json({ error: 'Список не совпадает с наборами стикеров' });
    }

    const setPosition = db.prepare('UPDATE sticker_packs SET position = ? WHERE id = ?');
    db.transaction(() => order.forEach((id, index) => setPosition.run(index, id)))();

    notifyStickersChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const pack = db.prepare('SELECT id FROM sticker_packs WHERE id = ?').get(id);
    if (!pack) return res.status(404).json({ error: 'Пак не найден' });

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Укажите название пака' });
      db.prepare('UPDATE sticker_packs SET name = ? WHERE id = ?').run(name.slice(0, 60), id);
    }

    if (req.body.enabled !== undefined) {
      db.prepare('UPDATE sticker_packs SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, id);
    }

    if (req.body.position !== undefined) {
      const position = Number(req.body.position);
      if (Number.isFinite(position)) {
        db.prepare('UPDATE sticker_packs SET position = ? WHERE id = ?').run(Math.floor(position), id);
      }
    }

    notifyStickersChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Обложка пака — своя картинка, отдельная от самих стикеров (в отличие от
// стикеров ей не нужен emoji и она не попадает в сетку выбора).
router.post('/admin/:id/cover', verifySuperAdmin, (req, res) => {
  stickerUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });

    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT cover_path FROM sticker_packs WHERE id = ?').get(packId);
    if (!pack) return res.status(404).json({ error: 'Пак не найден' });

    try {
      const coverPath = await saveStickerImage(req.file.buffer, 'cover');
      db.prepare('UPDATE sticker_packs SET cover_path = ? WHERE id = ?').run(coverPath, packId);
      unlinkStickerFile(pack.cover_path);

      notifyStickersChanged(req);
      res.json(adminPacks());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Загрузка стикера в пак. Каждому обязателен эмодзи — и метаданные, и
// fallback-глиф на случай, если картинка когда-либо перестанет резолвиться
// (см. CLAUDE.md про хранение стикера в сообщении).
router.post('/admin/:id/items', verifySuperAdmin, (req, res) => {
  stickerUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });

    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT id FROM sticker_packs WHERE id = ?').get(packId);
    if (!pack) return res.status(404).json({ error: 'Пак не найден' });

    const emoji = normalizeEmoji(req.body.emoji);
    if (!emoji) return res.status(400).json({ error: 'Укажите эмодзи для стикера' });

    const count = db.prepare('SELECT COUNT(*) AS c FROM sticker_items WHERE pack_id = ? AND retired = 0').get(packId).c;
    if (count >= MAX_ITEMS_PER_PACK) return res.status(400).json({ error: 'В паке слишком много стикеров' });

    try {
      const filePath = await saveStickerImage(req.file.buffer, 'sticker', { preserveAnimation: true });
      const nextPosition = db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sticker_items WHERE pack_id = ?'
      ).get(packId).p;
      const itemId = db.prepare(
        'INSERT INTO sticker_items (pack_id, file_path, emoji, position, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(packId, filePath, emoji, nextPosition, Date.now()).lastInsertRowid;

      notifyStickersChanged(req);
      res.status(201).json({ id: itemId, packs: adminPacks() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Правка эмодзи стикера. Картинка правится отдельной ручкой /image.
router.put('/admin/items/:itemId', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT id FROM sticker_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Стикер не найден' });

    const emoji = normalizeEmoji(req.body.emoji);
    if (!emoji) return res.status(400).json({ error: 'Укажите эмодзи для стикера' });
    db.prepare('UPDATE sticker_items SET emoji = ? WHERE id = ?').run(emoji, itemId);

    notifyStickersChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Замена картинки под тем же id — старые сообщения ссылаются на id, а не на
// путь, так что подмена видна сразу во всей истории (как правка опечатки).
router.post('/admin/items/:itemId/image', verifySuperAdmin, (req, res) => {
  stickerUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });

    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT file_path FROM sticker_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Стикер не найден' });

    try {
      const filePath = await saveStickerImage(req.file.buffer, 'sticker', { preserveAnimation: true });
      db.prepare('UPDATE sticker_items SET file_path = ? WHERE id = ?').run(filePath, itemId);
      unlinkStickerFile(item.file_path);

      notifyStickersChanged(req);
      res.json(adminPacks());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Во скольких сообщениях встречается этот стикер — спрашивается перед
// удалением, решение необратимо.
router.get('/admin/items/:itemId/usage', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT id FROM sticker_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Стикер не найден' });
    res.json({ count: usageCount(itemId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Порядок стикеров внутри пака — тем же способом, что у смайликов: список id
// целиком, drag-and-drop на клиенте задаёт его весь разом.
router.put('/admin/:packId/items/reorder', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.packId);
    const order = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    if (!order.length) return res.status(400).json({ error: 'Пустой порядок' });

    const belongs = db.prepare(
      'SELECT COUNT(*) AS c FROM sticker_items WHERE pack_id = ? AND retired = 0 AND id IN (' +
      order.map(() => '?').join(',') + ')'
    ).get(packId, ...order).c;
    if (belongs !== order.length) return res.status(400).json({ error: 'Список не совпадает с содержимым пака' });

    const setPosition = db.prepare('UPDATE sticker_items SET position = ? WHERE id = ? AND pack_id = ?');
    const applyOrder = db.transaction(() => {
      order.forEach((id, index) => setPosition.run(index, id, packId));
    });
    applyOrder();

    notifyStickersChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удаление стикера — настоящее: строка и файл(ы) с диска. Старые сообщения не
// ломаются молча: sticker_fallback скопирован в них на момент отправки (см.
// server/index.js), и вместо картинки они покажут этот эмодзи-глиф.
router.delete('/admin/items/:itemId', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT file_path FROM sticker_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Стикер не найден' });

    db.prepare('DELETE FROM sticker_items WHERE id = ?').run(itemId);
    unlinkStickerFile(item.file_path);

    notifyStickersChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT name FROM sticker_packs WHERE id = ?').get(packId);
    if (pack?.name === ARCHIVE_PACK_NAME) {
      return res.status(400).json({ error: 'Архив нельзя удалить: в нём хранятся стикеры из старых сообщений' });
    }

    // Стикеры пака пережидают его удаление в служебном паке — без переноса
    // они исчезли бы вместе с паком (FK не проверяется движком, см. db.js,
    // но код удаления пишем так, будто проверяется, чтобы поведение не
    // зависело от того, включат её потом или нет), а с ними — отрисовка всех
    // сообщений, которые на них ссылаются.
    const count = db.prepare('SELECT COUNT(*) AS c FROM sticker_items WHERE pack_id = ?').get(packId).c;
    if (count) {
      db.prepare('UPDATE sticker_items SET pack_id = ?, retired = 1 WHERE pack_id = ?')
        .run(archivePackId(), packId);
    }
    db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(packId);
    notifyStickersChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
