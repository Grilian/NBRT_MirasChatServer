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
// «Следы» — фирменное имя личного чата с сохранёнными сообщениями
// (переименование 07.09.2026 по концепции редизайна). Сущность прежняя:
// таблицы, ручки и идентификатор `self_<id>` не менялись — миграция данных
// ради нового слова в интерфейсе была бы платой ни за что.
const DEFAULT_SELF_CHAT_NAME = 'Следы';
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

// Набор реакций — обычные символы Unicode. Прежде здесь хранились коды вида
// `:u_1f601:` (след системы, где смайлик жил картинкой с именем), и на каждом
// чтении их приходилось сверять с каталогом по имени. Коды сняты 07.09.2026
// вместе со всей подсистемой; разовая нормализация в db.js перевела уже
// сохранённый набор в символы.
//
// Показывается реакция всё равно картинкой: клиент находит символ в каталоге
// отрисовки. Сам символ тут — и хранение, и запасной вид, если картинки нет.
function reactionCatalog() {
  const rows = db.prepare(`
    SELECT i.fallback_emoji, i.retired, p.enabled
    FROM emoji_items_resolved i
    JOIN emoji_packs p ON p.id = i.pack_id
    WHERE i.file_path IS NOT NULL AND i.fallback_emoji IS NOT NULL
    ORDER BY p.position, i.position, i.id
  `).all();
  const available = new Set();
  for (const row of rows) {
    if (row.enabled && !row.retired) available.add(row.fallback_emoji);
  }
  return available;
}

const unique = (values) => [...new Set(values)];

function getReactionEmoji() {
  const raw = getSetting(REACTION_EMOJI);
  if (!raw) return unique(DEFAULT_REACTIONS);
  const list = unique(raw.split(/\s+/).filter(Boolean));
  return list.length ? list : unique(DEFAULT_REACTIONS);
}

function setReactionEmoji(value) {
  const available = reactionCatalog();
  const source = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  // Оставляем только то, для чего в каталоге есть живая картинка: набор
  // задаётся в панели выбором из каталога, и произвольная строка сюда попасть
  // не должна.
  const list = unique(
    source.map((raw) => String(raw || '').trim()).filter((item) => item && available.has(item))
  );
  if (!list.length) {
    setSetting(REACTION_EMOJI, null); // пусто — возвращаемся к набору по умолчанию
    return unique(DEFAULT_REACTIONS);
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
