// Смайлики: элементы, наборы оформления, представление с путями.
//
// Шаг схемы. Порядок шагов задан в ../index.js и значение имеет: более
// поздние опираются на таблицы, заведённые более ранними.
module.exports = (db) => {
  // Миграция: кастомные смайлики картинками. Пак теперь бывает двух видов —
  // юникодный (как раньше, `emoji` заполнен) и картиночный (`file_path` + `name`).
  // Разделение по items, а не по паку: колонка `kind` на паке потребовала бы
  // запрещать смешивание, а запрещать нечего — вид элемента виден по нему самому.
  //
  // `name` — короткое имя вида :cat:, ИМЕННО ОНО уезжает в текст сообщения.
  // Картинку в `messages.text` не положить, а менять формат хранения сообщений
  // ради смайликов нельзя: там лежит трёхлетний архив, который трогать запрещено.
  try {
    db.exec(`ALTER TABLE emoji_items ADD COLUMN name TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
  // Имя уникально глобально, а не внутри пака: в тексте сообщения пака нет —
  // там только :name:, и по нему нужно однозначно найти картинку.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_items_name ON emoji_items(name) WHERE name IS NOT NULL`);

  // Миграция: `retired` — след прежнего порядка, когда смайлик не удалялся, а
  // прятался, и имя оставалось занятым навсегда. 12.08.2026 пользователь решил
  // иначе: удалили — значит не нужен, строка и файл стираются, имя освобождается
  // (см. DELETE /api/emoji/admin/custom/:itemId). Колонка осталась ради уже
  // спрятанных строк: их видно в панели, откуда их можно вернуть или снести
  // насовсем. Новые смайлики сюда больше не попадают.
  try {
    db.exec(`ALTER TABLE emoji_items ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    // Колонка уже есть
  }
  // Базовый юникодный эмодзи картиночного смайлика — для мест, где картинку
  // показать нечем: уведомления ОС, буфер обмена, alt пропавшего файла.
  try {
    db.exec(`ALTER TABLE emoji_items ADD COLUMN fallback_emoji TEXT`);
  } catch (e) {
    // Колонка уже есть
  }
  // Каталог: emoji_items — ЛОГИЧЕСКИЙ Unicode-смайлик, а файлы Apple / Telegram /
  // Google Fonts — его взаимозаменяемые оформления в emoji_assets. Ровно один
  // источник правды: колонок-среза file_path/animated_path на элементе больше
  // нет, путь считает представление emoji_items_resolved (см. ниже).
  for (const sql of [
    `ALTER TABLE emoji_items ADD COLUMN unicode_key TEXT`,
    `ALTER TABLE emoji_items ADD COLUMN label TEXT`,
    `ALTER TABLE emoji_items ADD COLUMN keywords TEXT`,
    `ALTER TABLE emoji_packs ADD COLUMN structure_key TEXT`,
  ]) {
    try { db.exec(sql); } catch (e) { /* колонка уже есть */ }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS emoji_asset_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('base', 'animation')),
      enabled INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emoji_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      asset_pack_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (item_id, asset_pack_id),
      FOREIGN KEY (item_id) REFERENCES emoji_items(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_pack_id) REFERENCES emoji_asset_packs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_emoji_assets_item ON emoji_assets(item_id);
    CREATE INDEX IF NOT EXISTS idx_emoji_assets_pack ON emoji_assets(asset_pack_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_items_unicode_key
      ON emoji_items(unicode_key) WHERE unicode_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS emoji_structure (
      unicode_key TEXT PRIMARY KEY,
      emoji TEXT NOT NULL,
      group_name TEXT NOT NULL,
      subgroup_name TEXT,
      position INTEGER NOT NULL,
      label TEXT,
      keywords TEXT
    );
  `);

  // Включение отдельной ВЕРСИИ у отдельного смайлика. Раньше вкл/выкл было
  // только на целом наборе (emoji_asset_packs.enabled) — то есть «убрать Apple
  // у одного смайлика, оставив у остальных» было невозможно в принципе. Нужно
  // для панели правки: у каждой версии в строке своя галочка.
  try {
    db.exec('ALTER TABLE emoji_assets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
  } catch (e) {
    // Колонка уже есть
  }

  const nowForEmojiAssets = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO emoji_asset_packs (key, name, role, enabled, active, position, created_at)
    VALUES ('apple', 'Apple', 'base', 1, 1, 0, ?)
  `).run(nowForEmojiAssets);
  db.prepare(`
    INSERT OR IGNORE INTO emoji_asset_packs (key, name, role, enabled, active, position, created_at)
    VALUES ('animation', 'Telegram Animation', 'animation', 1, 1, 1, ?)
  `).run(nowForEmojiAssets);

  // Бэкфилл emoji_assets из прежних колонок-среза и разбор служебного пака
  // «Архив смайликов» удалены 07.09.2026: обе миграции своё отработали (на проде
  // 3770 ресурсов Apple, 481 анимации, архивного пака нет), а колонок, из
  // которых они читали, больше не существует.

  // ===== Один источник правды об оформлении смайлика =====
  //
  // До 07.09.2026 emoji_items несла собственные file_path/animated_path —
  // «совместимый срез» активных наборов, который пересчитывался функцией
  // syncResolvedAssets после каждого импорта и каждого переключения. Срез был
  // нужен ради уже выкаченных клиентов, читавших путь прямо из элемента, и
  // ровно он делал данные двухголовыми: один и тот же факт лежал и в
  // emoji_assets, и на элементе, и расходился при любой пропущенной синхронизации.
  //
  // Обратная совместимость снята, поэтому колонки удалены, а путь считается на
  // лету представлением. Побочный выигрыш: удаление смайлика теперь убирает с
  // диска ВСЕ его файлы, а не только файлы активного набора — прежде картинка
  // неактивного оформления оставалась сиротой.
  for (const sql of [
    'ALTER TABLE emoji_items DROP COLUMN file_path',
    'ALTER TABLE emoji_items DROP COLUMN animated_path',
  ]) {
    try { db.exec(sql); } catch (e) { /* колонки уже нет */ }
  }

  // Порядок выбора тот же, что был у syncResolvedAssets: сначала активный набор,
  // потом остальные включённые по своей позиции. Поэтому неполный Google Fonts
  // можно наложить поверх полного Apple, не получив дыр. `a.enabled = 1` —
  // выключенная ВЕРСИЯ конкретного смайлика пропускается, и он опускается на
  // следующий набор, а не пропадает.
  db.exec('DROP VIEW IF EXISTS emoji_items_resolved');
  db.exec(`
    CREATE VIEW emoji_items_resolved AS
    SELECT
      ei.*,
      (SELECT a.file_path FROM emoji_assets a
         JOIN emoji_asset_packs p ON p.id = a.asset_pack_id
        WHERE a.item_id = ei.id AND p.role = 'base' AND p.enabled = 1 AND a.enabled = 1
        ORDER BY p.active DESC, p.position, p.id LIMIT 1) AS file_path,
      (SELECT a.file_path FROM emoji_assets a
         JOIN emoji_asset_packs p ON p.id = a.asset_pack_id
        WHERE a.item_id = ei.id AND p.role = 'animation' AND p.enabled = 1 AND a.enabled = 1
        ORDER BY p.active DESC, p.position, p.id LIMIT 1) AS animated_path
    FROM emoji_items ei
  `);

  // FK в этой базе движком не проверяются нигде (PRAGMA foreign_keys выключена
  // во всём проекте, см. комментарий у sticker_id ниже) — ON DELETE CASCADE в
  // схеме emoji_assets/emoji_items декоративный. Более ранний вариант пак- и
  // набор-удаления полагался на него и оставлял сиротские строки: элементы без
  // пака, ресурсы без элемента или набора. Идемпотентная подчистка — на уже
  // чистой базе просто ничего не находит.
  db.prepare('DELETE FROM emoji_items WHERE pack_id NOT IN (SELECT id FROM emoji_packs)').run();
  db.prepare('DELETE FROM emoji_assets WHERE item_id NOT IN (SELECT id FROM emoji_items)').run();
  db.prepare('DELETE FROM emoji_assets WHERE asset_pack_id NOT IN (SELECT id FROM emoji_asset_packs)').run();
};
