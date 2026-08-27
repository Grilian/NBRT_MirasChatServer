import React, { useEffect, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';

export interface StickerPackItem {
  id: number;
  file_path: string;
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
 * Пользовательский список стикеров. Паки переключаются компактными вкладками
 * с обложками — так же, как категории в EmojiPicker. Название остаётся только
 * в title/aria-label: в узкой мобильной панели текстовые вкладки не помещаются.
 */
const StickerPicker: React.FC<StickerPickerProps> = ({ onPick }) => {
  const [packs, setPacks] = useState<StickerPack[]>(cachedPacks || []);
  const [activePack, setActivePack] = useState(0);
  const [loading, setLoading] = useState(!cachedPacks);

  useEffect(() => {
    api.get('/stickers')
      .then(({ data }) => { cachedPacks = data; setPacks(data); })
      .catch(() => { if (!cachedPacks) setPacks([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activePack >= packs.length) setActivePack(0);
  }, [activePack, packs.length]);

  const current = packs[activePack];
  const stickers = current?.items || [];

  return (
    <>
      {packs.length > 1 && (
        <div className="emoji-tabs sticker-pack-tabs" role="tablist" aria-label="Наборы стикеров">
          {packs.map((pack, index) => {
            const cover = pack.cover_path || pack.items[0]?.file_path || null;
            return (
              <button
                key={pack.id}
                type="button"
                role="tab"
                aria-selected={index === activePack}
                aria-label={pack.name}
                title={pack.name}
                className={'emoji-tab sticker-pack-tab' + (index === activePack ? ' is-active' : '')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setActivePack(index)}
              >
                {cover
                  ? <img src={resolveUploadUrl(cover) || ''} alt="" draggable={false} />
                  : <span className="sticker-pack-tab-fallback">{pack.items[0]?.emoji || '🙂'}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="sticker-grid">
        {loading && <div className="emoji-empty">Загрузка…</div>}
        {!loading && (!current || stickers.length === 0) && (
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
    </>
  );
};

export default StickerPicker;
