const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const db = require('../db');
const verifyToken = require('../middleware/verifyToken');
const verifySuperAdmin = require('../middleware/verifySuperAdmin');
const {
  unicodeKeyFromFilename,
  emojiFromUnicodeKey,
  emojiCanonicalKey,
  hasSkinTone,
  skinToneIndex,
  ensureLogicalItem,
  listAssetPacks,
  parseStructureFile,
  applyStructure,
} = require('../services/emojiCatalog');

const router = express.Router();

// Корень загрузок берётся из userStorage — там он настраивается переменной
// MIRAS_UPLOADS_DIR ради тестов. Свой путь тут значил бы, что прогон тестов
// пишет картинки смайликов в боевой uploads мимо временного каталога.
const EMOJI_DIR = path.join(require('../services/userStorage').UPLOADS_DIR, 'emoji');
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

const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

const structureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
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
  const onDisk = path.join(require('../services/userStorage').UPLOADS_DIR, String(filePath).replace(/^\/uploads\//, ''));
  fs.unlink(onDisk, () => {});
};

// Сколько уже отправленных сообщений содержит код смайлика. Удаление их не
// портит — текст сообщения не меняется, — но картинка в них станет текстом
// :name:, и админ должен видеть цену решения до того, как нажмёт.
const usageCount = (name) => {
  if (!name) return 0;
  return db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text LIKE '%:' || ? || ':%'").get(name).c;
};

// Один смайлик — короткая строка. Ограничение по длине именно символьное и с
// запасом: составные эмодзи (флаги, семьи, модификаторы тона кожи) занимают до
// десятка кодовых точек, но всё, что длиннее, — это уже не смайлик, а текст.
const MAX_EMOJI_LENGTH = 32;
const MAX_ITEMS_PER_PACK = 10000;

// Все живые (включённые) оформления одного юникодного элемента — не только
// активное. Нужно для попапа выбора пака в композере: человек печатает 😃,
// видит поверх поля Apple (активный) и, если для этого же ключа загружен ещё
// и Google Fonts, может явно выбрать его вместо автоматического. Единым
// запросом на всю выдачу, а не по одному на элемент — иначе на паке из тысяч
// смайликов это N+1 в чистом виде.
//
// ТОЛЬКО `role = 'base'`. Анимационный набор (Telegram) — не альтернативное
// оформление, а анимированная версия того же самого смайлика: Apple и Telegram
// взаимозаменяемы и должны читаться как ОДИН набор. Пока сюда попадали обе
// роли, у каждого смайлика с анимацией появлялся выбор из двух «наборов»,
// хотя выбирать там нечего — и попап открывался там, где не должен был.
function variantsByItem(db) {
  const rows = db.prepare(`
    SELECT ea.item_id, eap.key AS pack_key, eap.name AS pack_name, eap.role, ea.file_path
    FROM emoji_assets ea
    JOIN emoji_asset_packs eap ON eap.id = ea.asset_pack_id
    WHERE eap.enabled = 1 AND eap.role = 'base' AND ea.enabled = 1
    ORDER BY eap.position, eap.id
  `).all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.item_id)) map.set(row.item_id, []);
    map.get(row.item_id).push({
      packKey: row.pack_key, packName: row.pack_name, role: row.role, filePath: row.file_path,
    });
  }
  return map;
}

function packsWithItems({ onlyEnabled, includeRaw = false }) {
  const packs = db.prepare(`
    SELECT id, name, position, enabled FROM emoji_packs
    ${onlyEnabled ? 'WHERE enabled = 1' : ''}
    ORDER BY position, id
  `).all();

  // `retired` — выключенный админом смайлик. Из панели ВЫБОРА он уходит
  // (вставить его больше нельзя), но в каталоге отрисовки остаётся: в уже
  // отправленных сообщениях лежит его символ, и подменять их системным
  // глифом задним числом мы не должны. Решение пользователя от 06.09.2026.
  const items = db.prepare(
    `SELECT id, pack_id, emoji, name, file_path, animated_path, fallback_emoji, position,
            unicode_key, label, keywords, retired
     FROM emoji_items_resolved
     ${onlyEnabled ? 'WHERE retired = 0' : ''}
     ORDER BY position, id`
  ).all();
  // Считается один раз на всю выдачу и только когда реально нужно: у выдачи
  // для панели админа (includeRaw) варианты ни к чему — наборы оформления там
  // уже видны отдельным разделом.
  const variants = onlyEnabled ? variantsByItem(db) : null;

  // Для панели правки — ВСЕ версии каждого смайлика, включая выключенные и
  // из выключенных наборов: именно там ими и управляют. В пользовательскую
  // выдачу это не попадает никогда (там есть variants, и только живые).
  const assetsByItem = new Map();
  if (includeRaw) {
    const rows = db.prepare(`
      SELECT ea.item_id, ea.file_path, ea.enabled,
             eap.id AS pack_id, eap.key AS pack_key, eap.name AS pack_name,
             eap.role, eap.enabled AS pack_enabled, eap.active AS pack_active
      FROM emoji_assets ea
      JOIN emoji_asset_packs eap ON eap.id = ea.asset_pack_id
      ORDER BY eap.role DESC, eap.position, eap.id
    `).all();
    for (const row of rows) {
      if (!assetsByItem.has(row.item_id)) assetsByItem.set(row.item_id, []);
      assetsByItem.get(row.item_id).push({
        pack_id: row.pack_id,
        pack_key: row.pack_key,
        pack_name: row.pack_name,
        role: row.role,
        file_path: row.file_path,
        enabled: !!row.enabled,
        pack_enabled: !!row.pack_enabled,
        pack_active: !!row.pack_active,
      });
    }
  }

  // Тоновые вариации схлопываются под базовый смайлик и в панели выбора, и в
  // панели админа: список из 3770 строк с пятью ячейками картинок в каждой —
  // это ровно та простыня, от которой уходим. В `/catalog` они по-прежнему
  // лежат россыпью: в сообщении хранится именно тоновый символ.
  // Карта строится заранее — базовый элемент может встретиться в списке позже
  // своей вариации.
  const toneOwner = new Map();
  const tonesByOwner = new Map();
  {
    // Сопоставление идёт по КАНОНИЧЕСКОМУ ключу (без тонов и без fe0f) — см.
    // emojiCanonicalKey: иначе смайлики, у которых база несёт селектор
    // начертания, свою базу не находят (🏋️ = 1f3cb-fe0f против 🏋🏻 = 1f3cb-1f3fb).
    const baseByCanonical = new Map();
    for (const item of items) {
      if (!item.unicode_key || hasSkinTone(item.unicode_key)) continue;
      const canonical = emojiCanonicalKey(item.unicode_key);
      if (canonical && !baseByCanonical.has(canonical)) baseByCanonical.set(canonical, item);
    }

    // Часть тоновых наборов не имеет базовой версии ВООБЩЕ: «держатся за
    // руки» без тонов кодируется одним символом (👬 = 1f46c), а с тонами —
    // ZWJ-последовательностью, и её незатонированной формы в каталоге нет.
    // Прятать такие вариации нельзя, показывать двадцатью карточками — тоже:
    // представителем становится первая из группы, остальные уходят внутрь.
    const groups = new Map();
    for (const item of items) {
      if (!item.unicode_key || !item.file_path || !hasSkinTone(item.unicode_key)) continue;
      const canonical = emojiCanonicalKey(item.unicode_key);
      if (!canonical) continue; // сами модификаторы 🏻🏼🏽🏾🏿 — самостоятельные смайлики
      if (!groups.has(canonical)) groups.set(canonical, []);
      groups.get(canonical).push(item);
    }

    for (const [canonical, list] of groups) {
      const owner = baseByCanonical.get(canonical) || list[0];
      for (const item of list) {
        if (item.id === owner.id) continue;
        toneOwner.set(item.id, owner.id);
      }
      tonesByOwner.set(owner.id, list.map((item) => ({
        // id нужен админской панели: выключение и удаление адресуются строке,
        // а не символу. Пользовательской выдаче он безвреден.
        id: item.id,
        unicode_key: item.unicode_key,
        unicode: item.fallback_emoji || '',
        file_path: item.file_path,
        animated_path: item.animated_path || null,
        fallback: item.fallback_emoji || '',
        toneIndex: skinToneIndex(item.unicode_key),
      })).sort((a, b) => a.toneIndex - b.toneIndex));
    }
  }

  const byPack = new Map();
  for (const item of items) {
    if (toneOwner.has(item.id)) continue;
    if (!byPack.has(item.pack_id)) byPack.set(item.pack_id, { emoji: [], custom: [], all: [] });
    const bucket = byPack.get(item.pack_id);
    // Картиночный элемент узнаётся по file_path, юникодный — по emoji либо
    // fallback_emoji. Юникодные элементы новой системы хранят '' в emoji
    // (сам символ живёт в fallback_emoji) — раньше сюда заглядывали только в
    // emoji, и элемент без ещё несинхронизированной картинки не попадал НИ В
    // ОДИН список: ни картинкой, ни текстом, — просто исчезал из выдачи.
    const isImage = !!(item.file_path && item.name);
    if (isImage) {
      // Список выбора для попапа — только когда реально есть из чего выбирать
      // (2+ живых оформления у одного и того же юникодного ключа). Для обычных
      // картиночных смайликов без unicode_key (старые ручные загрузки) вариантов
      // не бывает вовсе — там всегда одна картинка на одно имя.
      const itemVariants = item.unicode_key ? variants?.get(item.id) : null;
      bucket.custom.push({
        id: item.id,
        name: item.name,
        file_path: item.file_path,
        // Анимация приезжает отдельным полем: панель выбора обязана показывать
        // статичную (десяток дёргающихся картинок разом выбрать не даёт), а
        // переписка берёт анимированную — если она есть и человек её не выключил.
        animated_path: item.animated_path || null,
        fallback: item.fallback_emoji || '',
        unicode: item.fallback_emoji || '',
        unicode_key: item.unicode_key || null,
        label: item.label || '',
        keywords: item.keywords || '',
        ...(itemVariants && itemVariants.length > 1 ? { variants: itemVariants } : {}),
        // Тоны того же смайлика — от светлого к тёмному. Панель показывает
        // одну карточку, а выбрать конкретный тон можно удержанием.
        ...(tonesByOwner.has(item.id) ? { tones: tonesByOwner.get(item.id) } : {}),
      });
    } else {
      const glyph = item.emoji || item.fallback_emoji;
      if (glyph) bucket.emoji.push(glyph);
    }
    // Единый список для панели админа: там оба вида — карточки одного экрана,
    // и порядок между ними общий (перетаскивание не знает про виды).
    if (includeRaw) {
      bucket.all.push({
        id: item.id,
        name: item.name || '',
        emoji: item.emoji || '',
        file_path: item.file_path || null,
        animated_path: item.animated_path || null,
        fallback: item.fallback_emoji || '',
        unicode: item.fallback_emoji || '',
        unicode_key: item.unicode_key || null,
        label: item.label || '',
        keywords: item.keywords || '',
        // Выключён админом: из панели выбора ушёл, в переписке остался.
        retired: !!item.retired,
        // Все версии этого смайлика — по ним и рисуется строка правки.
        assets: assetsByItem.get(item.id) || [],
        // Тона следуют за базовым: своей кнопки у них нет, но показать их
        // в строке нужно, и удаление адресуется каждому по id.
        ...(tonesByOwner.has(item.id) ? { tones: tonesByOwner.get(item.id) } : {}),
      });
    }
  }

  const result = packs.map((pack) => {
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
      ...(includeRaw ? { items: bucket.all } : {}),
    };
  });
  return onlyEnabled
    ? result.filter((pack) => pack.emoji.length > 0 || pack.custom.length > 0)
    : result;
}

// Выдача для панели админа. Отдельной функцией, а не флагом по месту: включать
// сырой список обязаны ВСЕ админские ручки (иначе после любого действия он
// пропал бы из панели до перезагрузки), а пользовательская — ни одна.
const adminPacks = () => packsWithItems({ onlyEnabled: false, includeRaw: true });

function parseEmojiList(raw) {
  if (typeof raw === 'string') {
    // Из панели список приходит одной строкой — режем по пробелам и переводам
    // строки. Так его удобнее и вставлять, и править целиком.
    return raw.split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

// Состав категории задаётся строкой смайликов целиком. Прежде отсюда
// вычищались только элементы «без картинки» — так отличали юникодные от
// картиночных. Картиночных больше нет, значит и деления нет: заменяется весь
// состав. FK в этой базе движком не проверяются, поэтому emoji_assets чистим
// явно и ПЕРВЫМИ — они ссылаются на элементы.
function replaceItems(packId, list) {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM emoji_assets WHERE item_id IN (SELECT id FROM emoji_items WHERE pack_id = ?)'
    ).run(packId);
    db.prepare('DELETE FROM emoji_items WHERE pack_id = ?').run(packId);
  })();
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
//
// variants — по той же причине, что и в packsWithItems: явный выбор пака,
// сделанный при отправке (:e~<ключ>~<пак>:), должен доходить до всех, кто
// читает переписку, а не только до автора. Без этого поля сообщение с таким
// кодом рендерилось бы как попало — ни один получатель не смог бы понять,
// какую конкретно картинку выбрал отправитель.
router.get('/catalog', verifyToken, (req, res) => {
  try {
    const items = db.prepare(`
      SELECT id, name, file_path, animated_path, fallback_emoji AS fallback,
             unicode_key, label, keywords
      FROM emoji_items_resolved
      WHERE name IS NOT NULL AND file_path IS NOT NULL
    `).all();
    const variants = variantsByItem(db);
    res.json(items.map(({ id, ...item }) => {
      const itemVariants = item.unicode_key ? variants.get(id) : null;
      return itemVariants && itemVariants.length > 1 ? { ...item, variants: itemVariants } : item;
    }));
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

// Состояние новой системы ресурсов. Категории (emoji_packs) отвечают только
// за сортировку, а эти паки — за внешний вид одного и того же Unicode-смайлика.
router.get('/admin/system', verifySuperAdmin, (req, res) => {
  try {
    res.json({
      assetPacks: listAssetPacks(db),
      structure: db.prepare(`
        SELECT COUNT(*) AS item_count, COUNT(DISTINCT group_name) AS group_count
        FROM emoji_structure
      `).get(),
      logicalItems: db.prepare('SELECT COUNT(*) AS count FROM emoji_items WHERE unicode_key IS NOT NULL').get().count,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Импорт официального emoji-test.txt или собственного JSON. Он меняет только
// категории, порядок, подписи и ключевые слова — картинки не трогает.
router.post('/admin/structure', verifySuperAdmin, (req, res) => {
  structureUpload.single('structure')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось прочитать структуру' });
    if (!req.file) return res.status(400).json({ error: 'Выберите emoji-test.txt или JSON' });
    try {
      const entries = parseStructureFile(req.file.originalname, req.file.buffer);
      const report = applyStructure(db, entries);
      notifyEmojiChanged(req);
      res.json({ report, packs: adminPacks(), assetPacks: listAssetPacks(db) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// Один ZIP = один визуальный набор. Файл внутри определяется только по имени:
// U+1F600.webp, u_1f600.png и U+1F1E6-U+1F1E8.webp дают канонические ключи.
router.post('/admin/assets/import', verifySuperAdmin, (req, res) => {
  bundleUpload.single('archive')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить архив' });
    if (!req.file) return res.status(400).json({ error: 'Выберите ZIP-архив набора' });

    const role = String(req.body.role || 'base') === 'animation' ? 'animation' : 'base';
    const key = String(req.body.key || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
    const name = String(req.body.name || key || 'Emoji pack').trim().slice(0, 80);
    if (!key) return res.status(400).json({ error: 'Укажите код набора' });

    let entries;
    try {
      entries = new AdmZip(req.file.buffer).getEntries().filter((entry) => !entry.isDirectory);
    } catch {
      return res.status(400).json({ error: 'Архив ZIP повреждён или имеет неподдерживаемый формат' });
    }
    const images = entries.filter((entry) => /\.(png|jpe?g|webp|gif)$/i.test(entry.entryName));
    if (!images.length) return res.status(400).json({ error: 'В архиве нет PNG, JPEG, WebP или GIF' });
    if (images.length > 10000) return res.status(400).json({ error: 'В одном наборе допускается не более 10 000 файлов' });

    try {
      const existing = db.prepare('SELECT id FROM emoji_asset_packs WHERE key = ?').get(key);
      let assetPackId = existing?.id;
      if (assetPackId) {
        db.prepare('UPDATE emoji_asset_packs SET name = ?, role = ?, enabled = 1 WHERE id = ?')
          .run(name, role, assetPackId);
      } else {
        const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_asset_packs').get().p;
        const hasActive = db.prepare(
          'SELECT id FROM emoji_asset_packs WHERE role = ? AND enabled = 1 AND active = 1'
        ).get(role);
        assetPackId = db.prepare(`
          INSERT INTO emoji_asset_packs (key, name, role, enabled, active, position, created_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
        `).run(key, name, role, hasActive ? 0 : 1, next, Date.now()).lastInsertRowid;
      }

      const findAsset = db.prepare('SELECT file_path FROM emoji_assets WHERE item_id = ? AND asset_pack_id = ?');
      const saveAsset = db.prepare(`
        INSERT INTO emoji_assets (item_id, asset_pack_id, file_path, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(item_id, asset_pack_id) DO UPDATE SET file_path = excluded.file_path, created_at = excluded.created_at
      `);
      let imported = 0;
      let skipped = 0;
      const errors = [];

      for (const entry of images) {
        const unicodeKey = unicodeKeyFromFilename(entry.entryName);
        if (!unicodeKey) {
          skipped += 1;
          if (errors.length < 20) errors.push(`${entry.entryName}: имя не похоже на Unicode-код`);
          continue;
        }
        try {
          const buffer = entry.getData();
          if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error('слишком большой файл');
          const itemId = ensureLogicalItem(db, unicodeKey);
          const previous = findAsset.get(itemId, assetPackId);
          const stored = await saveEmojiImage(buffer, `${key}_${unicodeKey.replace(/-/g, '_')}`, {
            animated: role === 'animation',
          });
          saveAsset.run(itemId, assetPackId, stored, Date.now());
          if (previous?.file_path && previous.file_path !== stored) unlinkEmojiFile(previous.file_path);
          imported += 1;
        } catch (entryError) {
          skipped += 1;
          if (errors.length < 20) errors.push(`${entry.entryName}: ${entryError.message}`);
        }
      }
      notifyEmojiChanged(req);
      res.json({
        report: { imported, skipped, total: images.length, errors },
        packs: adminPacks(),
        assetPacks: listAssetPacks(db),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Порядок наборов оформления. Это НЕ косметика: позиция решает, откуда взять
// картинку, если в активном наборе её нет (представление emoji_items_resolved берёт сначала
// активный, потом по позиции). До сих пор порядок задавался только тем, в
// какой очерёдности наборы загружали, и поменять его было нечем.
router.put('/admin/assets/reorder', verifySuperAdmin, (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    const existing = db.prepare('SELECT id FROM emoji_asset_packs ORDER BY position, id').all().map((r) => r.id);
    const unique = new Set(order);
    if (order.length !== existing.length || unique.size !== order.length || order.some((id) => !existing.includes(id))) {
      return res.status(400).json({ error: 'Список не совпадает с наборами оформления' });
    }
    const setPosition = db.prepare('UPDATE emoji_asset_packs SET position = ? WHERE id = ?');
    db.transaction(() => order.forEach((id, index) => setPosition.run(index, id)))();
    notifyEmojiChanged(req);
    res.json({ assetPacks: listAssetPacks(db), packs: adminPacks() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Включение/выключение ОДНОЙ версии у ОДНОГО смайлика. Выключенная версия
// пропускается при подборе картинки, и смайлик опускается на следующий
// включённый набор — а не пропадает.
router.put('/admin/assets/:packId/items/:itemId', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.packId);
    const itemId = Number(req.params.itemId);
    const asset = db.prepare(
      'SELECT id FROM emoji_assets WHERE asset_pack_id = ? AND item_id = ?'
    ).get(packId, itemId);
    if (!asset) return res.status(404).json({ error: 'У этого смайлика нет версии из такого набора' });

    db.prepare('UPDATE emoji_assets SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, asset.id);
    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Выключение смайлика целиком — для юридических и цензурных задач. Из панели
// выбора он уходит, в уже отправленных сообщениях остаётся картинкой: текст
// сообщения не меняется, а подменять архив задним числом мы не должны.
// Тона следуют за базовым: выключил 👍 — ушли и все пять его вариаций.
router.put('/admin/custom/:itemId/enabled', verifySuperAdmin, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT id, unicode_key FROM emoji_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    const retired = req.body.enabled ? 0 : 1;
    const ids = [item.id];
    if (item.unicode_key) {
      const canonical = emojiCanonicalKey(item.unicode_key);
      if (canonical) {
        for (const row of db.prepare('SELECT id, unicode_key FROM emoji_items WHERE unicode_key IS NOT NULL').all()) {
          if (row.id !== item.id && emojiCanonicalKey(row.unicode_key) === canonical) ids.push(row.id);
        }
      }
    }
    const update = db.prepare('UPDATE emoji_items SET retired = ? WHERE id = ?');
    db.transaction(() => ids.forEach((id) => update.run(retired, id)))();

    notifyEmojiChanged(req);
    res.json({ packs: adminPacks(), changed: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Пачкой — цензурные правки приходят списком, а не по одному смайлику.
router.put('/admin/custom/enabled-bulk', verifySuperAdmin, (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ error: 'Пустой список' });
    const retired = req.body.enabled ? 0 : 1;

    // Каждый выбранный тянет за собой свои тона — правило то же, что поштучно.
    const all = db.prepare('SELECT id, unicode_key FROM emoji_items WHERE unicode_key IS NOT NULL').all();
    const picked = new Set(ids);
    const canonicals = new Set();
    for (const row of all) if (picked.has(row.id)) canonicals.add(emojiCanonicalKey(row.unicode_key));
    const target = new Set(ids);
    for (const row of all) if (canonicals.has(emojiCanonicalKey(row.unicode_key))) target.add(row.id);

    const update = db.prepare('UPDATE emoji_items SET retired = ? WHERE id = ?');
    db.transaction(() => [...target].forEach((id) => update.run(retired, id)))();

    notifyEmojiChanged(req);
    res.json({ packs: adminPacks(), changed: target.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/assets/:id', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const pack = db.prepare('SELECT id, role FROM emoji_asset_packs WHERE id = ?').get(id);
    if (!pack) return res.status(404).json({ error: 'Набор ресурсов не найден' });
    if (req.body.enabled !== undefined) {
      db.prepare('UPDATE emoji_asset_packs SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, id);
    }
    if (req.body.active) {
      db.transaction(() => {
        db.prepare('UPDATE emoji_asset_packs SET active = 0 WHERE role = ?').run(pack.role);
        db.prepare('UPDATE emoji_asset_packs SET active = 1, enabled = 1 WHERE id = ?').run(id);
      })();
    }
    notifyEmojiChanged(req);
    res.json({ assetPacks: listAssetPacks(db), packs: adminPacks() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Раньше удалить загруженный набор оформления (ZIP с Apple/Telegram
// Animation/Google Fonts) было нельзя вовсе — ручки не существовало, и кнопка
// «Используется»/«Выбрать» на карточке набора создавала обманчивое впечатление
// нерабочей блокировки. Удаление настоящее: сами файлы с диска, строки из
// emoji_assets и сама строка набора. Активная роль после удаления передаётся
// следующему включённому набору той же роли, если такой остался, — иначе роль
// просто не имеет активного набора, и представление честно оставит
// элементы без картинки этой роли (они всё равно останутся видны как обычный
// Unicode-символ, см. packsWithItems).
//
// FK в этой базе движком не проверяются (PRAGMA foreign_keys выключена во всём
// проекте — см. комментарий у sticker_id в db.js), поэтому ON DELETE CASCADE у
// emoji_assets декоративный: сам он ничего не подчистит. Строки убираем явно.
router.delete('/admin/assets/:id', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const pack = db.prepare('SELECT id, role, active FROM emoji_asset_packs WHERE id = ?').get(id);
    if (!pack) return res.status(404).json({ error: 'Набор ресурсов не найден' });

    const files = db.prepare('SELECT file_path FROM emoji_assets WHERE asset_pack_id = ?').all(id);

    db.transaction(() => {
      db.prepare('DELETE FROM emoji_assets WHERE asset_pack_id = ?').run(id);
      db.prepare('DELETE FROM emoji_asset_packs WHERE id = ?').run(id);
      if (pack.active) {
        const next = db.prepare(
          'SELECT id FROM emoji_asset_packs WHERE role = ? AND enabled = 1 ORDER BY position, id LIMIT 1'
        ).get(pack.role);
        if (next) db.prepare('UPDATE emoji_asset_packs SET active = 1 WHERE id = ?').run(next.id);
      }
    })();

    files.forEach((row) => unlinkEmojiFile(row.file_path));
    notifyEmojiChanged(req);
    res.json({ assetPacks: listAssetPacks(db), packs: adminPacks() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ручки картиночных смайликов (загрузка, замена файла, базовый эмодзи,
// снятие анимации, счётчик употреблений, свой порядок) удалены 07.09.2026
// вместе с самим понятием. Способ их СОЗДАНИЯ был закрыт ещё раньше, на
// проде не осталось ни одного такого элемента (все 3770 — юникодные), а
// новая панель правки не звала ни одну из них. Туда же ушла разовая
// миграция /admin/migrate-unicode-tokens: единственное место во всём
// проекте, которое переписывало текст уже отправленных сообщений.

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

// Порядок паков = порядок компактных вкладок в пользовательском пикере.
// Принимаем полный список id и меняем позиции одной транзакцией.
router.put('/admin/reorder', verifySuperAdmin, (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    const existing = db.prepare('SELECT id FROM emoji_packs ORDER BY position, id').all().map((row) => row.id);
    const unique = new Set(order);
    if (order.length !== existing.length || unique.size !== order.length || order.some((id) => !existing.includes(id))) {
      return res.status(400).json({ error: 'Список не совпадает с паками смайликов' });
    }

    const setPosition = db.prepare('UPDATE emoji_packs SET position = ? WHERE id = ?');
    db.transaction(() => order.forEach((id, index) => setPosition.run(index, id)))();

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const pack = db.prepare('SELECT id, structure_key FROM emoji_packs WHERE id = ?').get(id);
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
    //
    // Но НЕ у авто-категории: категории из загруженной структуры (structure_key)
    // наполняет импорт, и замена состава руками снесла бы оттуда всё.
    if (req.body.emoji !== undefined) {
      if (pack.structure_key) {
        return res.status(400).json({
          error: 'Это категория из загруженной структуры — её состав задаёт импорт, а не список вручную',
        });
      }
      replaceItems(id, parseEmojiList(req.body.emoji));
    }

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const item = db.prepare('SELECT id FROM emoji_items WHERE id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Смайлик не найден' });

    // Файлы берём из emoji_assets — ВСЕ оформления, а не только активное.
    // Прежний код читал file_path/animated_path со среза и уносил лишь две
    // картинки из трёх: версия неактивного набора оставалась на диске сиротой.
    const files = db.prepare('SELECT file_path FROM emoji_assets WHERE item_id = ?').all(itemId);

    // FK в этой базе движком не проверяются (см. комментарий у sticker_id в
    // db.js) — ON DELETE CASCADE у emoji_assets декоративный, чистим сами.
    db.transaction(() => {
      db.prepare('DELETE FROM emoji_assets WHERE item_id = ?').run(itemId);
      db.prepare('DELETE FROM emoji_items WHERE id = ?').run(itemId);
    })();
    files.forEach((row) => unlinkEmojiFile(row.file_path));

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/:id', verifySuperAdmin, (req, res) => {
  try {
    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT id, structure_key, name FROM emoji_packs WHERE id = ?').get(packId);
    if (!pack) return res.status(404).json({ error: 'Пак не найден' });

    // Авто-категорию удалять нельзя. Это не «пак смайликов», а раздел из
    // загруженной структуры Unicode, и его удаление снесло бы все элементы
    // раздела ВМЕСТЕ С КАРТИНКАМИ загруженных наборов — при том что карточка
    // самого набора продолжила бы показывать прежнее число файлов. Спрятать
    // раздел можно выключением (enabled), это обратимо.
    if (pack.structure_key) {
      return res.status(400).json({
        error: `«${pack.name}» — раздел из загруженной структуры, а не пак. `
          + 'Удаление снесло бы картинки наборов; чтобы убрать раздел из панели, выключите его.',
      });
    }

    // Удаление настоящее — 12.08.2026 решено не резервировать имена навсегда
    // (см. комментарий у /admin/custom/:itemId выше). Пак ведёт себя так же:
    // картиночные элементы удаляются вместе с файлами с диска, а не переезжают
    // в архив. В уже отправленных сообщениях на месте картинки останется текст
    // :name: — тот же компромисс, что и при удалении одного смайлика.
    const files = db.prepare(`
      SELECT a.file_path FROM emoji_assets a
      WHERE a.item_id IN (SELECT id FROM emoji_items WHERE pack_id = ?)
    `).all(packId);

    // FK в этой базе движком не проверяются (PRAGMA foreign_keys выключена во
    // всём проекте — см. комментарий у sticker_id в db.js), поэтому все
    // ON DELETE CASCADE в схеме декоративные и сами ничего не подчищают.
    // Порядок важен: сперва emoji_assets (ссылаются на emoji_items), потом
    // сами элементы, потом пак.
    db.transaction(() => {
      db.prepare(
        'DELETE FROM emoji_assets WHERE item_id IN (SELECT id FROM emoji_items WHERE pack_id = ?)'
      ).run(packId);
      db.prepare('DELETE FROM emoji_items WHERE pack_id = ?').run(packId);
      db.prepare('DELETE FROM emoji_packs WHERE id = ?').run(packId);
    })();

    files.forEach((row) => unlinkEmojiFile(row.file_path));

    notifyEmojiChanged(req);
    res.json(adminPacks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
