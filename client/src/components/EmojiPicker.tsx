import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';
import { CustomEmoji } from '../utils/customEmoji';

export interface EmojiPack {
  id: number;
  name: string;
  emoji: string[];
  /** Кастомные смайлики-картинки; в текст уходит их :name:. */
  custom?: CustomEmoji[];
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
              title={pack.name}
              aria-label={pack.name}
            >
              {/* Только значок: названия паков занимали всю ширину шапки, а на
                  телефоне вкладки от них не помещались. Название осталось в
                  подсказке и в aria-label — для мыши и для читалки. */}
              <span className="emoji-tab-icon">
                {pack.emoji[0] || (pack.custom?.[0]
                  ? <img className="custom-emoji" src={resolveUploadUrl(pack.custom[0].file_path) || ''} alt="" />
                  : '🙂')}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="emoji-grid">
        {loading && <div className="emoji-empty">Загрузка…</div>}
        {!loading && (!current || (current.emoji.length === 0 && !current.custom?.length)) && (
          <div className="emoji-empty">Смайлики пока не добавлены</div>
        )}
        {/* Кастомные идут первыми: их добавляли осознанно под этот коллектив,
            а юникодных всегда много и они одинаковы везде. */}
        {current?.custom?.map((item) => (
          <button
            key={`c${item.id}`}
            type="button"
            className="emoji-cell"
            title={`:${item.name}:`}
            onMouseDown={(e) => e.preventDefault()}
            // В сообщение уходит код, а не картинка: текст сообщения остаётся
            // текстом, формат хранения переписки не меняется.
            onClick={() => onPick(`:${item.name}:`)}
          >
            <img className="custom-emoji" src={resolveUploadUrl(item.file_path) || ''} alt={`:${item.name}:`} />
          </button>
        ))}
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
