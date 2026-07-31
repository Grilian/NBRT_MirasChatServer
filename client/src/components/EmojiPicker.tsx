import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';

export interface EmojiPack {
  id: number;
  name: string;
  emoji: string[];
}

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

// Паки грузятся один раз на всё приложение: набор меняется редко (правит
// супер-админ в панели), а панель открывают часто — перезапрашивать список на
// каждое открытие незачем.
let cachedPacks: EmojiPack[] | null = null;

const EmojiPicker: React.FC<EmojiPickerProps> = ({ onPick, onClose }) => {
  const [packs, setPacks] = useState<EmojiPack[]>(cachedPacks || []);
  const [activePack, setActivePack] = useState(0);
  const [loading, setLoading] = useState(!cachedPacks);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cachedPacks) return;
    api.get('/emoji')
      .then(({ data }) => { cachedPacks = data; setPacks(data); })
      .catch(() => setPacks([]))
      .finally(() => setLoading(false));
  }, []);

  // Закрытие по клику мимо и по Escape. Клик по самой кнопке-смайлику в
  // composer'е сюда не долетает — она останавливает всплытие и переключает
  // панель сама, иначе панель закрывалась бы и открывалась одним нажатием.
  useEffect(() => {
    const onDocPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };

    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('touchstart', onDocPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('touchstart', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const current = packs[activePack];

  return (
    <div className="emoji-picker" ref={rootRef}>
      {packs.length > 1 && (
        <div className="emoji-tabs">
          {packs.map((pack, index) => (
            <button
              key={pack.id}
              type="button"
              className={'emoji-tab' + (index === activePack ? ' is-active' : '')}
              onClick={() => setActivePack(index)}
            >
              {/* Вкладку подписываем первым смайликом пака — так она читается
                  с одного взгляда; полное название остаётся в подсказке. */}
              <span className="emoji-tab-icon">{pack.emoji[0] || '🙂'}</span>
              <span className="emoji-tab-name">{pack.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="emoji-grid">
        {loading && <div className="emoji-empty">Загрузка…</div>}
        {!loading && (!current || current.emoji.length === 0) && (
          <div className="emoji-empty">Смайлики пока не добавлены</div>
        )}
        {current?.emoji.map((emoji, index) => (
          <button
            key={`${emoji}-${index}`}
            type="button"
            className="emoji-cell"
            // onMouseDown с preventDefault: иначе фокус уходит из поля ввода,
            // на телефоне закрывается клавиатура, а на компьютере теряется
            // позиция курсора — и смайлик вставляется не туда, где стоял.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
};

export default EmojiPicker;
