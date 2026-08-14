// Каталог стикеров для ОТРИСОВКИ уже отправленных сообщений.
//
// Ровно тот же принцип, что у каталога кастомных смайликов (utils/customEmoji):
// «что можно вставить сейчас» (GET /stickers) и «как показать то, что уже
// отправлено» (GET /stickers/catalog) — два разных вопроса. Выключение пака не
// должно превращать старую переписку в пустые места, поэтому каталог отдаёт
// всё, что когда-либо существовало.
//
// Отличие от смайликов: сообщение ссылается на стикер числовым id, а не кодом
// внутри текста, поэтому здесь нет ни разбора шорткодов, ни превращения текста
// в узлы — только карта id → картинка.

export interface StickerCatalogEntry {
  filePath: string;
  animatedPath: string | null;
  /** Эмодзи стикера — он же запасной глиф, если картинки не окажется. */
  emoji: string;
}

export type StickerCatalog = Record<number, StickerCatalogEntry>;

interface StickerCatalogRow {
  id: number;
  file_path: string;
  animated_path?: string | null;
  emoji?: string | null;
}

export function buildStickerCatalog(rows: StickerCatalogRow[]): StickerCatalog {
  const catalog: StickerCatalog = {};
  if (!Array.isArray(rows)) return catalog;
  for (const row of rows) {
    if (!row || typeof row.id !== 'number' || !row.file_path) continue;
    catalog[row.id] = {
      filePath: row.file_path,
      animatedPath: row.animated_path || null,
      emoji: row.emoji || '',
    };
  }
  return catalog;
}
