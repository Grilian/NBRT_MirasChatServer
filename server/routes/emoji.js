const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const verifySuperAdmin = require('../middleware/verifySuperAdmin');

const router = express.Router();

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

  const items = db.prepare('SELECT id, pack_id, emoji FROM emoji_items ORDER BY position, id').all();
  const byPack = new Map();
  for (const item of items) {
    if (!byPack.has(item.pack_id)) byPack.set(item.pack_id, []);
    byPack.get(item.pack_id).push(item.emoji);
  }

  return packs.map((pack) => ({
    id: pack.id,
    name: pack.name,
    position: pack.position,
    enabled: !!pack.enabled,
    emoji: byPack.get(pack.id) || [],
  }));
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
  db.prepare('DELETE FROM emoji_items WHERE pack_id = ?').run(packId);
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

router.delete('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM emoji_packs WHERE id = ?').run(Number(req.params.id));
    res.json(packsWithItems({ onlyEnabled: false }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
