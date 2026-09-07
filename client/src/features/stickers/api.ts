// Каталог стикеров. Та же развилка, что у смайликов: `/stickers/catalog` —
// для отрисовки уже отправленного, `/stickers` — для панели выбора.

import api from '@/shared/api/client';

export interface StickerCatalogEntry {
  id: number;
  file_path: string;
  emoji: string;
}

export async function fetchStickerCatalog(): Promise<StickerCatalogEntry[]> {
  const { data } = await api.get('/stickers/catalog');
  return data;
}
