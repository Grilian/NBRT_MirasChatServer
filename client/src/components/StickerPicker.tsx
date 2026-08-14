import React, { useEffect, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';

export interface StickerPackItem {
  id: number;
  file_path: string;
  animated_path: string | null;
  emoji: string;
}

export interface StickerPack {
  id: number;
  name: string;
  cover_path: string | null;
  items: StickerPackItem[];
}

interface StickerPickerProps {
  /** Тап по стикеру отправляет его сразу — это самостоятельное сообщение. */
  onPick: (stickerId: number) => void;
}

// Свой кэш, зеркало cachedPacks у смайликов, а не общий с ними: наборы меняются
// по разным сокет-событиям (`emoji_changed` / `stickers_changed`), и связывать
// их в одну сущность значило бы сбрасывать оба на каждое изменение любого.
let cachedPacks: StickerPack[] | null = null;

/** Сбросить кэш — по событию `stickers_changed` от сервера. */
export const invalidateStickerPackCache = () => { cachedPacks = null; };

/**
 * Пользовательский список стикеров.
 *
 * По требованию у обычного человека НЕТ навигации по пакам: он открывает
 * вкладку и видит единый список всего, что ему доступно. Паки существуют в
 * модели данных и в админке, но здесь они только задают порядок — стикеры из
 * них склеиваются в одну ленту в том же порядке, в каком админ их расставил.
 */
const StickerPicker: React.FC<StickerPickerProps> = ({ onPick }) => {
  const [packs, setPacks] = useState<StickerPack[]>(cachedPacks || []);
  const [loading, setLoading] = useState(!cachedPacks);

  useEffect(() => {
    api.get('/stickers')
      .then(({ data }) => { cachedPacks = data; setPacks(data); })
      .catch(() => { if (!cachedPacks) setPacks([]); })
      .finally(() => setLoading(false));
  }, []);

  const stickers = packs.flatMap((pack) => pack.items);

  return (
    <div className="sticker-grid">
      {loading && <div className="emoji-empty">Загрузка…</div>}
      {!loading && stickers.length === 0 && (
        <div className="emoji-empty">Стикеры пока не добавлены</div>
      )}
      {stickers.map((sticker) => (
        <button
          key={sticker.id}
          type="button"
          className="sticker-cell"
          title={sticker.emoji}
          // preventDefault по той же причине, что у смайликов: без него фокус
          // уходит из поля ввода и на телефоне закрывается клавиатура.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(sticker.id)}
        >
          <img src={resolveUploadUrl(sticker.file_path) || ''} alt={sticker.emoji} draggable={false} />
        </button>
      ))}
    </div>
  );
};

export default StickerPicker;
