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

// Имена файлам дают по коду самого эмодзи (`u_1f4a2`, `u_1f60a`, составные —
// `u_1f1f7_1f1fa`), поэтому базовый эмодзи в большинстве случаев выводится из
// имени и руками его вбивать не нужно. Не вывелось — не беда: базовый эмодзи
// необязателен, клиент подставит свой.
const fallbackFromName = (name) => {
  const m = /^u_([0-9a-f_]+)$/.exec(String(name || ''));
  if (!m) return null;
  const points = m[1].split('_').filter(Boolean).map((p) => parseInt(p, 16));
  // Отсекаем и мусор, и то, что кодовой точкой быть не может: `u_12` — это,
  // скорее всего, просто имя, а не символ U+0012.
  if (!points.length || points.some((p) => !Number.isFinite(p) || p < 0x80 || p > 0x10ffff)) return null;
  try {
    return String.fromCodePoint(...points);
  } catch {
    return null;
  }
};

// Сохранение картинки смайлика. `animated` — не «разрешить анимацию», а выбор
// версии: у статичной анимацию нужно СРЕЗАТЬ (sharp без animated берёт только
// первый кадр), иначе загруженная гифка дёргалась бы и в панели выбора, где
// десяток шевелящихся картинок разом не даёт ничего выбрать.
async function saveEmojiImage(buffer, name, { animated }) {
  const filename = `emoji_${name}_${crypto.randomBytes(4).toString('hex')}.webp`;
  await sharp(buffer, animated ? { animated: true } : {})
    .resize(EMOJI_MAX_DIMENSION, EMOJI_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toFile(path.join(EMOJI_DIR, filename));
  return `/uploads/emoji/${filename}`;
}

// Файл смайлика с диска. Путь в БД — вида /uploads/emoji/<файл>, на диске он
// лежит относительно каталога сервера.
const unlinkEmojiFile = (filePath) => {
  if (!filePath) return;
  const onDisk = path.join(__dirname, '..', String(filePath).replace(/^\/uploads\//, 'uploads/'));
  fs.unlink(onDisk, () => {});
};

// Сколько уже отправленных сообщений содержит код смайлика. Удаление их не
// портит — текст сообщения не меняется, — но картинка в них станет текстом
// :name:, и админ должен видеть цену решения до того, как нажмёт.
const usageCount = (name) => {
  if (!name) return 0;
  return db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text LIKE '%:' || ? || ':%'").get(name).c;
};

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

function packsWithItems({ onlyEnabled, includeRetired = false }) {
  const packs = db.prepare(`
    SELECT id, name, position, enabled FROM emoji_packs
    ${onlyEnabled ? 'WHERE enabled = 1' : ''}
    ORDER BY position, id
  `).all();

  // `retired` — след прежнего порядка, когда смайлики прятали вместо удаления
  // (теперь удаление настоящее). Спрятанные строки ещё есть в базе, и панели
  // админа они нужны — оттуда их возвращают или сносят; в панель ВЫБОРА они не
  // попадают никогда.
  const items = db.prepare(
    `SELECT id, pack_id, emoji, name, file_path, animated_path, fallback_emoji, retired, position
     FROM emoji_items ${includeRetired ? '' : 'WHERE retired = 0'} ORDER BY position, id`
  ).all();
  const byPack = new Map();
  for (const item of items) {
    if (!byPack.has(item.pack_id)) byPack.set(item.pack_id, { emoji: [], custom: [], all: [] });
    const bucket = byPack.get(item.pack_id);
    // Картиночный элемент узнаётся по file_path, юникодный — по emoji.
    const isImage = !!(item.file_path && item.name);
    if (isImage && !item.retired) {
      bucket.custom.push({
        id: item.id,
        name: item.name,
        file_path: item.file_path,
        // Анимация приезжает отдельным полем: панель выбора обязана показывать
        // статичную (десяток дёргающихся картинок разом выбрать не даёт), а
        // переписка берёт анимированную — если она есть и человек её не выключил.
        animated_path: item.animated_path || null,
        fallback: item.fallback_emoji || '',
      });
    } else if (item.emoji && !item.retired) {
      bucket.emoji.push(item.emoji);
    }
    // Единый список для панели админа: там оба вида — карточки одного экрана,
    // и порядок между ними общий (перетаскивание не знает про виды).
    if (includeRetired) {
      bucket.all.push({
        id: item.id,
        name: item.name || '',
        emoji: item.emoji || '',
        file_path: item.file_path || null,
        animated_path: item.animated_path || null,
        fallback: item.fallback_emoji || '',
        retired: !!item.retired,
      });
    }
  }

  return packs.map((pack) => {
    const bucket = byPack.get(pack.id) || { emoji: [], custom: [], all: [] };
    return {
      id: pack.id,
      name: pack.name,
      position: pack.position,
      enabled: !!pack.enabled,
      // Поле emoji оставлено как было: на нём держатся и старая панель, и
      // уже выкаченные клиенты — их ломать нельзя.
      emoji: bucket.emoji,
      custom: bucket.custom,
      // Ключа нет вовсе в пользовательской выдаче: там не бывает ни спрятанных,
      // ни сырого списка — пустой массив читался бы как «бывают, но сейчас нет».
      ...(includeRetired ? { items: bucket.all } : {}),
    };
  });
}

// Выдача для панели админа. Отдельной функцией, а не флагом по месту: включать
// убранные обязаны ВСЕ админские ручки (иначе после любого действия они пропали
// бы из панели до перезагрузки), а пользовательская — ни одна.
const adminPacks = () => packsWithItems({ onlyEnabled: false, includeRetired: true });

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
      SELECT name, file_path, animated_path, fallback_emoji AS fallback
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

    const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_packs').get().p;
    const packId = db.prepare(
      'INSERT INTO emoji_packs (name, position, enabled, created_at) VALUES (?, ?, 1, ?)'
    ).run(name, nextPosition, Date.now()).lastInsertRowid;

    replaceItems(packId, parseEmojiList(req.body.emoji));
    notifyEmojiChanged(req);
    res.status(201).json(adminPacks());
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
    res.json(adminPacks());
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
    // Имя занято и убранным смайликом тоже: выдать его ДРУГОЙ картинке значило
    // бы задним числом подменить картинку в уже отправленных сообщениях. Но за
    // именем стоит конкретный смайлик, и вернуть в оборот ЕГО — законно (это же
    // имя, тот же смайлик, новая картинка), поэтому вместе с отказом уезжает и
    // то, чем на него ответить: id убранного элемента.
    const taken = db.prepare('SELECT id, pack_id, retired FROM emoji_items WHERE name = ?').get(name);
    if (taken) {
      return res.status(409).json({
        error: taken.retired
          ? `Смайлик :${name}: был убран раньше — его можно вернуть`
          : `Смайлик :${name}: уже существует`,
        code: taken.retired ? 'name_retired' : 'name_taken',
        itemId: taken.id,
        packId: taken.pack_id,
      });
    }

    const count = db.prepare('SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND retired = 0').get(packId).c;
    if (count >= MAX_ITEMS_PER_PACK) return res.status(400).json({ error: 'В паке слишком много элементов' });

    try {
      const filePath = await saveEmojiImage(req.file.buffer, name, { animated: false });

      const nextPosition = db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_items WHERE pack_id = ?'
      ).get(packId).p;
      // emoji объявлена NOT NULL ещё в исходной схеме — у картиночного
      // элемента её роль играет пустая строка, а вид определяется по file_path.
      // Базовый эмодзи: что прислали, иначе выводим из имени (`u_1f4a2` → 💢).
      const fallback = normalizeFallback(req.body.fallback) || fallbackFromName(name);
      db.prepare("INSERT INTO emoji_items (pack_id, emoji, name, file_path, fallback_emoji, position) VALUES (?, '', ?, ?, ?, ?)")
        .run(packId, name, filePath, fallback, nextPosition);

      notifyEmojiChanged(req);
      res.status(201).json(adminPacks());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Юникодный смайлик — элемент без картинки: в панели выбора показывается сам
// символ, и в сообщение уезжает он же, а не код. Поэтому имя такому элементу не
// нужно вовсе и удаление его ничего не ломает: в тексте сообщения лежит символ,
// а не ссылка на строку в базе.
router.post('/admin/:id/unicode', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.id);
    if (!db.prepare('SELECT id FROM emoji_packs WHERE id = ?').get(packId)) {
      return res.status(404).json({ error: 'Пак не найден' });
    }
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji) return res.status(400).json({ error: 'Укажите смайлик' });
    if ([...emoji].length > MAX_EMOJI_LENGTH) return res.status(400).json({ error: 'Это не похоже на смайлик' });

    const count = db.prepare('SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND retired = 0').get(packId).c;
    if (count >= MAX_ITEMS_PER_PACK) return res.status(400).json({ error: 'В паке слишком много элементов' });

    const nextPosition = db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_items WHERE pack_id = ?'
    ).get(packId).p;
    db.prepare('INSERT INTO emoji_items (pack_id, emoji, position) VALUES (?, ?, ?)').run(packId, emoji, nextPosition);

    notifyEmojiChanged(req);
    res.status(201).json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Правка элемента: базовый эмодзи у картиночного, сам символ у юникодного. Имя
// не правится ничем и никогда — оно уехало в тексты отправленных сообщений, и
// переименование превратило бы их в мёртвые коды.
router.put('/admin/custom/:itemId', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT id, file_path FROM emoji_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    if (item.file_path) {
      db.prepare('UPDATE emoji_items SET fallback_emoji = ? WHERE id = ?')
        .run(normalizeFallback(req.body.fallback), itemId);
    } else if (req.body.emoji !== undefined) {
      const emoji = String(req.body.emoji || '').trim();
      if (!emoji) return res.status(400).json({ error: 'Укажите смайлик' });
      if ([...emoji].length > MAX_EMOJI_LENGTH) return res.status(400).json({ error: 'Это не похоже на смайлик' });
      db.prepare('UPDATE emoji_items SET emoji = ? WHERE id = ?').run(emoji, itemId);
    }

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Замена картинки под тем же именем и кодом. В отличие от загрузки нового
// смайлика, это НЕ заводит новую строку: код :name: в старых сообщениях
// один и тот же, меняется только то, что за ним показывается — как правка
// опечатки в уже отправленной картинке, а не новый смайлик.
//
// `kind` выбирает версию: `static` — та, что видна в панели выбора и вообще
// везде; `animated` — та, что показывается только в переписке.
router.post('/admin/custom/:itemId/image', verifySuperAdmin, (req, res) => {
  emojiUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не распознан как изображение (jpeg/png/webp/gif)' });

    const itemId = Number(req.params.itemId);
    const animated = String(req.body.kind || req.query.kind || 'static') === 'animated';
    const item = db.prepare('SELECT name, file_path, animated_path FROM emoji_items WHERE id = ? AND file_path IS NOT NULL').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    try {
      const saved = await saveEmojiImage(req.file.buffer, item.name, { animated });
      const column = animated ? 'animated_path' : 'file_path';
      db.prepare(`UPDATE emoji_items SET ${column} = ? WHERE id = ?`).run(saved, itemId);

      // Прежний файл больше ни на что не ссылается: код :name: разрешается в
      // путь на лету, и старая переписка со следующего запроса каталога покажет
      // уже новую картинку. Оставлять его незачем — только копится мусор.
      unlinkEmojiFile(animated ? item.animated_path : item.file_path);

      notifyEmojiChanged(req);
      res.json(adminPacks());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Снять анимацию, оставив смайлик: статичная версия — обязательная, анимация
// поверх неё необязательна, и убирать их надо порознь.
router.delete('/admin/custom/:itemId/animated', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT animated_path FROM emoji_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    db.prepare('UPDATE emoji_items SET animated_path = NULL WHERE id = ?').run(itemId);
    unlinkEmojiFile(item.animated_path);

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Во скольких отправленных сообщениях встречается код смайлика. Спрашивается
// перед удалением: решение необратимое, и цену видно заранее.
router.get('/admin/custom/:itemId/usage', verifySuperAdmin, (req, res) => {
  try {
    const item = db.prepare('SELECT name FROM emoji_items WHERE id = ?').get(Number(req.params.itemId));
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });
    res.json({ count: usageCount(item.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Порядок элементов внутри пака — целиком по присланному списку id: список
// задать проще, чем гонять запрос на каждую перестановку, и при перетаскивании
// всё равно меняется вся последовательность. Порядок ОБЩИЙ для обоих видов:
// в панели они лежат вперемешку одними карточками, и перетаскивание про виды
// не знает.
router.put('/admin/:packId/custom/reorder', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.packId);
    const order = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    if (!order.length) return res.status(400).json({ error: 'Пустой порядок' });

    const belongs = db.prepare(
      'SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND retired = 0 AND id IN (' +
      order.map(() => '?').join(',') + ')'
    ).get(packId, ...order).c;
    if (belongs !== order.length) return res.status(400).json({ error: 'Список не совпадает с содержимым пака' });

    const setPosition = db.prepare('UPDATE emoji_items SET position = ? WHERE id = ? AND pack_id = ?');
    const applyOrder = db.transaction(() => {
      order.forEach((id, index) => setPosition.run(index, id, packId));
    });
    applyOrder();

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удаление смайлика — НАСТОЯЩЕЕ: строка из БД и оба файла с диска. Так решено
// 12.08.2026: «удалили — значит больше не нужен», резервирование имени навсегда
// признано лишним. Цена решения: в уже отправленных сообщениях на месте
// картинки останется текст :name: (само сообщение не меняется — там и лежит
// этот код), а имя освобождается и может быть выдано другой картинке. Поэтому
// панель перед удалением показывает, в скольких сообщениях код встречается
// (GET /usage). Для юникодных элементов вопрос не стоит вовсе: в сообщение
// уезжает сам символ, а не ссылка на строку.
router.delete('/admin/custom/:itemId', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT file_path, animated_path FROM emoji_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    db.prepare('DELETE FROM emoji_items WHERE id = ?').run(itemId);
    unlinkEmojiFile(item.file_path);
    unlinkEmojiFile(item.animated_path);

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Возврат убранного смайлика. Уборка обязана быть обратимой: имя закреплено за
// смайликом навсегда, поэтому «убрать и загрузить заново» — не обходной путь, а
// тупик, и админ оставался без единого способа вернуть картинку в оборот.
// Правило при этом не ослабляется: возвращается ТА ЖЕ строка (тот же id, то же
// имя), а не имя, выданное другому смайлику, — старые сообщения от этого не
// меняются. Новую картинку под тем же кодом ставит отдельная ручка /image.
router.put('/admin/custom/:itemId/restore', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT id, pack_id, name FROM emoji_items WHERE id = ? AND file_path IS NOT NULL').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    // По умолчанию смайлик возвращается туда, где лежал. Исключение — архив:
    // туда попадают смайлики из удалённых паков, сам архив выключен, и возврат
    // «на место» оставил бы смайлик ровно так же невидимым. Поэтому для них пак
    // назначения обязателен.
    const targetId = req.body.packId === undefined ? item.pack_id : Number(req.body.packId);
    const target = db.prepare('SELECT id, name FROM emoji_packs WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'Пак не найден' });
    if (target.name === ARCHIVE_PACK_NAME) {
      return res.status(400).json({ error: 'Выберите обычный пак: архив в панели выбора не показывается' });
    }

    const count = db.prepare('SELECT COUNT(*) AS c FROM emoji_items WHERE pack_id = ? AND retired = 0').get(target.id).c;
    if (count >= MAX_ITEMS_PER_PACK) return res.status(400).json({ error: 'В паке слишком много элементов' });

    const nextPosition = db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_items WHERE pack_id = ?'
    ).get(target.id).p;
    db.prepare('UPDATE emoji_items SET retired = 0, pack_id = ?, position = ? WHERE id = ?')
      .run(target.id, nextPosition, itemId);

    notifyEmojiChanged(req);
    res.json(adminPacks());
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
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
