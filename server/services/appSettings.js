const db = require('../db');

// Момент, раньше которого клиентам не следует ставить уже скачанное
// обновление. Unix-миллисекунды, как и остальные наши метки времени: у SQLite
// CURRENT_TIMESTAMP нет таймзоны в строке, и разбор такой строки в JS даёт
// сдвиг на часовой пояс читающего — ровно та путаница, из-за которой время
// сброса пароля тоже хранится числом.
const UPDATE_NOT_BEFORE = 'update_not_before';

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), Date.now());
}

function getUpdateNotBefore() {
  const raw = getSetting(UPDATE_NOT_BEFORE);
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : null;
}

function setUpdateNotBefore(ms) {
  setSetting(UPDATE_NOT_BEFORE, ms === null ? null : String(ms));
}

// Название личного чата «для себя». Одно на всех: это не персональная
// настройка, а то, как эта штука называется в организации — «Избранное»,
// «Облако» или «Архив» — и в клиентах она должна называться одинаково.
const SELF_CHAT_NAME = 'self_chat_name';
const DEFAULT_SELF_CHAT_NAME = 'Избранное';
const SELF_CHAT_NAME_MAX = 40;

function getSelfChatName() {
  const raw = getSetting(SELF_CHAT_NAME);
  return raw && raw.trim() ? raw.trim() : DEFAULT_SELF_CHAT_NAME;
}

function setSelfChatName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    setSetting(SELF_CHAT_NAME, null); // пусто — возвращаемся к названию по умолчанию
    return DEFAULT_SELF_CHAT_NAME;
  }
  if (trimmed.length > SELF_CHAT_NAME_MAX) throw new Error('Название слишком длинное');
  setSetting(SELF_CHAT_NAME, trimmed);
  return trimmed;
}

// Когда админ последний раз разбирал вкладку «Интернет». Всё, что
// зарегистрировалось позже, помечается как New — это метка «ещё не смотрели»,
// а не «зарегистрировался недавно», поэтому храним момент просмотра, а не
// возраст учётной записи.
const INTERNET_SEEN_AT = 'internet_tab_seen_at';

function getInternetSeenAt() {
  const raw = getSetting(INTERNET_SEEN_AT);
  const ms = Number(raw);
  return raw && Number.isFinite(ms) ? ms : 0;
}

function setInternetSeenAt(ms) {
  setSetting(INTERNET_SEEN_AT, String(ms));
}

// Базовый набор реакций хранит shortcodes загруженных картинок. Старые Unicode
// значения преобразуются по fallback_emoji, чтобы системные эмодзи оставались
// только резервом на случай отсутствующей или сломанной картинки.
const REACTION_EMOJI = 'reaction_emoji';
const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const SHORTCODE = /^:([a-z0-9_]{2,32}):$/;

function reactionCatalog() {
  const rows = db.prepare(`
    SELECT i.name, i.fallback_emoji, i.unicode_key, i.retired, p.enabled
    FROM emoji_items i
    JOIN emoji_packs p ON p.id = i.pack_id
    WHERE i.file_path IS NOT NULL AND i.name IS NOT NULL
    ORDER BY p.position, i.position, i.id
  `).all();
  const allByName = new Map();
  const enabledByFallback = new Map();
  for (const row of rows) {
    allByName.set(row.name, row);
    if (row.enabled && !row.retired && row.fallback_emoji && !enabledByFallback.has(row.fallback_emoji)) {
      enabledByFallback.set(row.fallback_emoji, row);
    }
  }
  return { allByName, enabledByFallback };
}

const unique = (values) => [...new Set(values)];

function defaultsForCatalog(catalog) {
  return unique(DEFAULT_REACTIONS.map((fallback) => {
    const row = catalog.enabledByFallback.get(fallback);
    return row ? (row.unicode_key ? fallback : `:${row.name}:`) : fallback;
  }));
}

function getReactionEmoji() {
  const catalog = reactionCatalog();
  const raw = getSetting(REACTION_EMOJI);
  if (!raw) return defaultsForCatalog(catalog);
  const list = raw.split(/\s+/).filter(Boolean).map((value) => {
    const shortcode = SHORTCODE.exec(value);
    if (shortcode) return catalog.allByName.has(shortcode[1]) ? value : null;
    const row = catalog.enabledByFallback.get(value);
    return row ? (row.unicode_key ? value : `:${row.name}:`) : value;
  }).filter(Boolean);
  return list.length ? unique(list) : defaultsForCatalog(catalog);
}

function setReactionEmoji(value) {
  const catalog = reactionCatalog();
  const source = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  const list = unique(source.map((raw) => String(raw || '').trim()).filter(Boolean).map((item) => {
    const shortcode = SHORTCODE.exec(item);
    if (shortcode) {
      const row = catalog.allByName.get(shortcode[1]);
      return row && row.enabled && !row.retired ? item : null;
    }
    const row = catalog.enabledByFallback.get(item);
    return row ? (row.unicode_key ? item : `:${row.name}:`) : null;
  }).filter(Boolean));
  if (!list.length) {
    setSetting(REACTION_EMOJI, null); // пусто — возвращаемся к набору по умолчанию
    return defaultsForCatalog(catalog);
  }
  setSetting(REACTION_EMOJI, list.join(' '));
  return list;
}

module.exports = {
  getUpdateNotBefore,
  setUpdateNotBefore,
  getReactionEmoji,
  setReactionEmoji,
  getSelfChatName,
  setSelfChatName,
  DEFAULT_SELF_CHAT_NAME,
  getInternetSeenAt,
  setInternetSeenAt,
};
