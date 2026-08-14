import React, { useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import StickerPicker from './StickerPicker';
import { PickedCustomEmoji } from './EmojiComposerField';
import { dismissLayerWithoutUnderlayActivation } from '../utils/dismissLayer';

type ContentTab = 'emoji' | 'stickers' | 'gif';

interface ContentPickerProps {
  onPick: (emoji: string | PickedCustomEmoji) => void;
  /** Стикер отправляется сразу, а не вставляется в поле ввода. */
  onSendSticker?: (stickerId: number) => void;
  onClose: () => void;
  mobilePanel?: boolean;
  mobileHeight?: number;
}

const TABS: { id: ContentTab; label: string }[] = [
  { id: 'emoji', label: 'Эмодзи' },
  { id: 'stickers', label: 'Стикеры' },
  { id: 'gif', label: 'GIF' },
];

/**
 * Общая панель выбора: «Эмодзи / Стикеры / GIF».
 *
 * Корневой контейнер, закрытие по клику мимо и высота мобильной панели живут
 * здесь, а не в каждой вкладке: иначе получилось бы несколько вложенных
 * контейнеров, каждый со своим обработчиком закрытия, и панель захлопывалась
 * бы от собственного клика.
 */
const ContentPicker: React.FC<ContentPickerProps> = ({
  onPick, onSendSticker, onClose, mobilePanel = false, mobileHeight,
}) => {
  const [tab, setTab] = useState<ContentTab>('emoji');
  const rootRef = useRef<HTMLDivElement>(null);

  // Та же логика, что была в EmojiPicker: на мобильном это не всплывашка, а
  // постоянная нижняя панель вместо клавиатуры, и закрывать её по любому
  // касанию снаружи нельзя — кнопка-переключатель находится снаружи панели.
  useEffect(() => {
    if (mobilePanel) return;

    const onDocPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        dismissLayerWithoutUnderlayActivation(event, onClose);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, mobilePanel]);

  return (
    <div
      className={'emoji-picker content-picker' + (mobilePanel ? ' is-mobile-panel' : '')}
      ref={rootRef}
      style={mobilePanel && mobileHeight ? { height: `${mobileHeight}px` } : undefined}
    >
      <div className="content-picker-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={'content-picker-tab' + (tab === item.id ? ' is-active' : '')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="content-picker-body">
        {tab === 'emoji' && <EmojiPicker onPick={onPick} onClose={onClose} embedded />}
        {tab === 'stickers' && (
          onSendSticker
            ? <StickerPicker onPick={onSendSticker} />
            : <div className="emoji-empty">Стикеры недоступны в этом окне</div>
        )}
        {/* GIF — заглушка: источника контента для них пока нет, а место в
            раскладке панель занимает уже сейчас, чтобы вкладка не появлялась
            задним числом и не сдвигала остальные. */}
        {tab === 'gif' && <div className="emoji-empty">Скоро</div>}
      </div>
    </div>
  );
};

export default ContentPicker;
