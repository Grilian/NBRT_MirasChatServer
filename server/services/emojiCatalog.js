const path = require('path');

const GROUP_LABELS_RU = {
  'Smileys & Emotion': 'Смайлики и эмоции',
  'People & Body': 'Люди и тело',
  'Component': 'Компоненты',
  'Animals & Nature': 'Животные и природа',
  'Food & Drink': 'Еда и напитки',
  'Travel & Places': 'Путешествия и места',
  'Activities': 'Занятия',
  'Objects': 'Предметы',
  'Symbols': 'Символы',
  'Flags': 'Флаги',
};

const normalizeUnicodeKey = (raw) => {
  const parts = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/u\+/g, '')
    .replace(/^u[_+-]?/, '')
    .split(/[\s_+\-]+/)
    .filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[0-9a-f]{2,6}$/.test(part))) return null;
  const points = parts.map((part) => Number.parseInt(part, 16));
  if (points.some((point) => point < 0x80 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))) return null;
  return points.map((point) => point.toString(16)).join('-');
};

const unicodeKeyFromFilename = (filename) => {
  const basename = path.basename(String(filename || ''), path.extname(String(filename || '')));
  return normalizeUnicodeKey(basename.replace(/^emoji[_-]?/i, ''));
};

const emojiFromUnicodeKey = (key) => {
  const normalized = normalizeUnicodeKey(key);
  if (!normalized) return null;
  try {
    return String.fromCodePoint(...normalized.split('-').map((part) => Number.parseInt(part, 16)));
  } catch {
    return null;
  }
};

const internalNameFromUnicodeKey = (key) => `u_${key.replace(/-/g, '_')}`;

const structurePackKey = (group) => `unicode:${String(group).trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-')}`;

function ensureCategory(db, groupName, preferredPosition = null) {
  const key = structurePackKey(groupName);
  const existing = db.prepare('SELECT id FROM emoji_packs WHERE structure_key = ?').get(key);
  if (existing) return existing.id;
  const next = preferredPosition ?? db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_packs').get().p;
  return db.prepare(`
    INSERT INTO emoji_packs (name, position, enabled, created_at, structure_key)
    VALUES (?, ?, 1, ?, ?)
  `).run(GROUP_LABELS_RU[groupName] || groupName || 'Другие', next, Date.now(), key).lastInsertRowid;
}

function structureForKey(db, unicodeKey) {
  return db.prepare(`
    SELECT unicode_key, emoji, group_name, subgroup_name, position, label, keywords
    FROM emoji_structure WHERE unicode_key = ?
  `).get(unicodeKey);
}

function ensureLogicalItem(db, unicodeKey) {
  const key = normalizeUnicodeKey(unicodeKey);
  if (!key) throw new Error('Некорректный Unicode-код');
  const existing = db.prepare('SELECT id FROM emoji_items WHERE unicode_key = ?').get(key);
  if (existing) return existing.id;

  const internalName = internalNameFromUnicodeKey(key);
  const byLegacyName = db.prepare('SELECT id FROM emoji_items WHERE name = ?').get(internalName);
  if (byLegacyName) {
    db.prepare('UPDATE emoji_items SET unicode_key = COALESCE(unicode_key, ?) WHERE id = ?').run(key, byLegacyName.id);
    return byLegacyName.id;
  }

  const structure = structureForKey(db, key);
  const group = structure?.group_name || 'Другие';
  const packId = ensureCategory(db, group);
  const next = structure?.position ?? db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM emoji_items WHERE pack_id = ?'
  ).get(packId).p;
  const fallback = structure?.emoji || emojiFromUnicodeKey(key) || '';
  return db.prepare(`
    INSERT INTO emoji_items
      (pack_id, emoji, name, fallback_emoji, position, unicode_key, label, keywords)
    VALUES (?, '', ?, ?, ?, ?, ?, ?)
  `).run(
    packId,
    internalName,
    fallback,
    next,
    key,
    structure?.label || '',
    structure?.keywords || '',
  ).lastInsertRowid;
}

function listAssetPacks(db) {
  return db.prepare(`
    SELECT p.id, p.key, p.name, p.role, p.enabled, p.active, p.position,
           COUNT(a.id) AS item_count
    FROM emoji_asset_packs p
    LEFT JOIN emoji_assets a ON a.asset_pack_id = p.id
    GROUP BY p.id
    ORDER BY p.position, p.id
  `).all().map((pack) => ({ ...pack, enabled: !!pack.enabled, active: !!pack.active }));
}

function activeAssetPack(db, role) {
  return db.prepare(`
    SELECT id, key, name, role FROM emoji_asset_packs
    WHERE role = ? AND enabled = 1 AND active = 1
    ORDER BY position, id LIMIT 1
  `).get(role);
}

// Старые клиенты читают file_path/animated_path прямо из emoji_items. После
// импорта или переключения оформления обновляем эти поля одним проходом.
function syncResolvedAssets(db) {
  db.transaction(() => {
    // Если в выбранном оформлении конкретного смайлика нет, берём его из
    // следующего включённого base-пака. Поэтому неполный Google Fonts можно
    // безопасно наложить на полный Apple, не получая дыр в каталоге.
    db.prepare(`
      UPDATE emoji_items
      SET file_path = (
        SELECT a.file_path
        FROM emoji_assets a
        JOIN emoji_asset_packs p ON p.id = a.asset_pack_id
        WHERE a.item_id = emoji_items.id AND p.role = 'base' AND p.enabled = 1
        ORDER BY p.active DESC, p.position, p.id
        LIMIT 1
      ),
      animated_path = (
        SELECT a.file_path
        FROM emoji_assets a
        JOIN emoji_asset_packs p ON p.id = a.asset_pack_id
        WHERE a.item_id = emoji_items.id AND p.role = 'animation' AND p.enabled = 1
        ORDER BY p.active DESC, p.position, p.id
        LIMIT 1
      )
      WHERE unicode_key IS NOT NULL
    `).run();
  })();
}

function parseEmojiTest(text) {
  const entries = [];
  let group = 'Другие';
  let subgroup = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('# group:')) {
      group = line.slice('# group:'.length).trim() || 'Другие';
      continue;
    }
    if (line.startsWith('# subgroup:')) {
      subgroup = line.slice('# subgroup:'.length).trim();
      continue;
    }
    if (!line || line.startsWith('#') || !line.includes(';')) continue;
    const match = /^([0-9A-F ]+)\s*;\s*([^#]+)#\s*(\S+)\s+(?:E[\d.]+\s+)?(.+)$/i.exec(line);
    if (!match) continue;
    // Не полностью квалифицированные дубли не нужны: файл набора должен
    // однозначно соответствовать одной канонической последовательности.
    if (!/fully-qualified|component/i.test(match[2])) continue;
    const key = normalizeUnicodeKey(match[1]);
    if (!key) continue;
    entries.push({
      unicode_key: key,
      emoji: match[3],
      group_name: group,
      subgroup_name: subgroup,
      label: match[4].trim(),
      keywords: `${match[4]} ${subgroup}`.replace(/[-_]/g, ' '),
    });
  }
  return entries;
}

function parseStructureFile(filename, buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (/\.json$/i.test(filename)) {
    const parsed = JSON.parse(text);
    const source = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(source)) throw new Error('JSON должен содержать массив items');
    return source.map((item) => {
      const key = normalizeUnicodeKey(item.unicode_key || item.code || item.codes);
      if (!key) return null;
      return {
        unicode_key: key,
        emoji: item.emoji || emojiFromUnicodeKey(key) || '',
        group_name: item.group_name || item.group || 'Другие',
        subgroup_name: item.subgroup_name || item.subgroup || '',
        label: item.label || item.name || '',
        keywords: Array.isArray(item.keywords) ? item.keywords.join(' ') : (item.keywords || ''),
      };
    }).filter(Boolean);
  }
  return parseEmojiTest(text);
}

function applyStructure(db, entries) {
  if (!entries.length) throw new Error('В файле не найдено ни одного эмодзи');
  const groups = [...new Set(entries.map((entry) => entry.group_name || 'Другие'))];
  const insertStructure = db.prepare(`
    INSERT INTO emoji_structure
      (unicode_key, emoji, group_name, subgroup_name, position, label, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateItem = db.prepare(`
    UPDATE emoji_items
    SET pack_id = ?, position = ?, fallback_emoji = ?, label = ?, keywords = ?
    WHERE unicode_key = ?
  `);

  db.transaction(() => {
    db.prepare('DELETE FROM emoji_structure').run();
    groups.forEach((group, index) => ensureCategory(db, group, index));
    entries.forEach((entry, index) => {
      insertStructure.run(
        entry.unicode_key,
        entry.emoji || emojiFromUnicodeKey(entry.unicode_key) || '',
        entry.group_name || 'Другие',
        entry.subgroup_name || '',
        index,
        entry.label || '',
        entry.keywords || '',
      );
      const packId = ensureCategory(db, entry.group_name || 'Другие');
      updateItem.run(
        packId,
        index,
        entry.emoji || emojiFromUnicodeKey(entry.unicode_key) || '',
        entry.label || '',
        entry.keywords || '',
        entry.unicode_key,
      );
    });
  })();
  return { item_count: entries.length, group_count: groups.length };
}

module.exports = {
  normalizeUnicodeKey,
  unicodeKeyFromFilename,
  emojiFromUnicodeKey,
  internalNameFromUnicodeKey,
  ensureLogicalItem,
  listAssetPacks,
  activeAssetPack,
  syncResolvedAssets,
  parseStructureFile,
  applyStructure,
};
