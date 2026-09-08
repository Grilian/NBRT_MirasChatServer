// Типы каталога смайликов, общие для вкладок «Реакции» и «Следы»: обе
// показывают один и тот же выбор эмодзи. В монолите они лежали между двумя
// панелями и принадлежали как бы обеим сразу — при разборе по файлам это
// пришлось назвать явно.

export interface EmojiCustomItem {
  id: number;
  name: string;
  file_path: string;
  animated_path?: string | null;
  fallback: string;
  unicode?: string | null;
  unicode_key?: string | null;
  label?: string;
  keywords?: string;
}

/**
 * Элемент пака в панели админа. Вид определяется по `file_path`: есть картинка —
 * картиночный смайлик (в сообщение уезжает код `:name:`), нет — юникодный (в
 * сообщение уезжает сам символ `emoji`). Оба показываются одинаковыми карточками
 * в одном списке, и порядок у них общий.
 */
export interface EmojiItem {
  id: number;
  name: string;
  emoji: string;
  file_path: string | null;
  animated_path: string | null;
  fallback: string;
  unicode?: string | null;
  unicode_key?: string | null;
  label?: string;
  keywords?: string;
}

export interface EmojiPack {
  id: number;
  name: string;
  enabled: boolean;
  emoji: string[];
  custom?: EmojiCustomItem[];
  // Полный список элементов пака — только в админской выдаче.
  items?: EmojiItem[];
}




// Имена файлам дают по коду эмодзи (`u_1f4a2`), поэтому базовый смайл почти
// всегда выводится из имени. Тот же разбор, что и на сервере (routes/emoji.js).

// Смайлики хранятся текстом (юникод), а не картинками, поэтому пак правится
// одним полем: строка со смайликами через пробел. Это и «загрузить новый», и
// «отредактировать» одновременно — отдельного загрузчика файлов не нужно.
