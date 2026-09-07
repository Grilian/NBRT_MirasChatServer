// Каталог смайликов.
//
// Каталог ОТРИСОВКИ и каталог ВЫБОРА — два разных вопроса, и путать их нельзя.
// `/emoji/catalog` отвечает на «как показать то, что уже отправлено»: в нём
// есть всё, что когда-либо существовало, независимо от того, выключен ли
// смайлик сейчас. `/emoji` — «что можно вставить», он живёт в самой панели.

import api from '@/shared/api/client';

export interface CatalogEntry {
  name: string;
  file_path: string;
  animated_path?: string | null;
  fallback?: string | null;
  unicode_key?: string | null;
  label?: string | null;
  keywords?: string | null;
  variants?: { packKey: string; packName: string; filePath: string; role: 'base' | 'animation' }[];
}

export async function fetchEmojiCatalog(): Promise<CatalogEntry[]> {
  const { data } = await api.get('/emoji/catalog');
  return data;
}
