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

  const items = db.prepare('SELECT id, pack_id, emoji, name, file_path FROM emoji_items ORDER BY position, id').all();
  const byPack = new Map();
  for (const item of items) {
    if (!byPack.has(item.pack_id)) byPack.set(item.pack_id, { emoji: [], custom: [] });
    const bucket = byPack.get(item.pack_id);
    // Картиночный элемент узнаётся по file_path, юникодный — по emoji.
    if (item.file_path && item.name) {
      bucket.custom.push({ id: item.id, name: item.name, file_path: item.file_path });
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

// Панель выбора смайликов у обычного пользователя — только включённые паки.
router.get('/', verifyToken, (req, res) => {
  try {
    res.json(packsWithItems({ onlyEnabled: true }));
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
    if (db.prepare('SELECT 1 FROM emoji_items WHERE name = ?').get(name)) {
      return res.status(409).json({ error: `Смайлик :${name}: уже существует` });
    }

    const count = db.prepare('SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ?').get(packId).c;
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
      db.prepare("INSERT INTO emoji_items (pack_id, emoji, name, file_path, position) VALUES (?, '', ?, ?, ?)")
        .run(packId, name, `/uploads/emoji/${filename}`, nextPosition);

      res.status(201).json(packsWithItems({ onlyEnabled: false }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Удаление кастомного смайлика. Файл с диска НЕ трогаем: он уже показан в
// отправленных сообщениях, и стерев его, мы сломали бы старую переписку.
router.delete('/admin/custom/:itemId', verifySuperAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM emoji_items WHERE id = ? AND file_path IS NOT NULL').run(Number(req.params.itemId));
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM emoji_packs WHERE id = ?').run(Number(req.params.id));
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
