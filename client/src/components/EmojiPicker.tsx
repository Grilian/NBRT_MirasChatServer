import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';
import { CustomEmoji, DEFAULT_EMOJI_FALLBACK } from '../utils/customEmoji';
import { PickedCustomEmoji } from './EmojiComposerField';

export interface EmojiPack {
  id: number;
  name: string;
  emoji: string[];
  /** Кастомные смайлики-картинки; в текст уходит их :name:. */
  custom?: CustomEmoji[];
}

interface EmojiPickerProps {
  /**
   * Юникодный смайлик отдаётся строкой, картиночный — объектом: поле ввода
   * показывает его картинкой и строит узел прямо из этих данных, а искать их
   * заново по имени незачем — здесь они уже под рукой.
   */
  onPick: (emoji: string | PickedCustomEmoji) => void;
  onClose: () => void;
}

// Кэш только чтобы не мигать пустой панелью на каждое открытие (компонент
// размонтируется при закрытии — см. MessageInput, `{emojiOpen && <EmojiPicker
// .../>}`). Раньше на нём стояла ранняя остановка «если кэш уже есть —
// не перезапрашивать вовсе», и пак, добавленный супер-админом уже ПОСЛЕ
// первого открытия панели у конкретного человека, не появлялся до
// перезапуска приложения — тот же баг, что чинили для отрисовки кастомных
// смайликов в сообщениях (Chat.tsx, обновление на реконнекте), просто в
// другом месте. Показываем старые данные мгновенно, а свежие подтягиваем
// на каждое открытие панели — запрос лёгкий, лишним не будет.
let cachedPacks: EmojiPack[] | null = null;

/**
 * Сбросить кэш — по событию `emoji_changed` от сервера. Без этого панель после
 * правки состава в панели управления показала бы старые данные до тех пор, пока
 * её не откроют дважды: первое открытие отдаёт кэш и только запускает запрос.
 */
export const invalidateEmojiPackCache = () => { cachedPacks = null; };

const EmojiPicker: React.FC<EmojiPickerProps> = ({ onPick, onClose }) => {
  const [packs, setPacks] = useState<EmojiPack[]>(cachedPacks || []);
  const [activePack, setActivePack] = useState(0);
  const [loading, setLoading] = useState(!cachedPacks);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get('/emoji')
      .then(({ data }) => { cachedPacks = data; setPacks(data); })
      .catch(() => { if (!cachedPacks) setPacks([]); })
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
            // В сообщение всё равно уходит код, а не картинка — формат хранения
            // переписки не меняется. Картинка нужна только полю ввода, чтобы
            // показать человеку смайлик вместо технического :name:.
            onClick={() => onPick({
              name: item.name,
              filePath: item.file_path,
              fallback: item.fallback || DEFAULT_EMOJI_FALLBACK,
            })}
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
