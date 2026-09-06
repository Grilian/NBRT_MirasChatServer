import React, { useEffect, useRef } from 'react';
import { EmojiVariant } from '../utils/customEmoji';
import { resolveUploadUrl } from '../utils/uploads';
import { dismissLayerWithoutUnderlayActivation } from '../utils/dismissLayer';

interface Props {
  /** Все живые оформления одного и того же смайлика — базовые паки и анимация вперемешку. */
  variants: EmojiVariant[];
  /** Путь картинки, которая уже вставлена по умолчанию — подсвечиваем её как текущую. */
  currentFilePath: string;
  /** Верх и середина только что вставленного узла в системе координат окна — попап встаёт над ним. */
  anchorRect: DOMRect;
  onPick: (variant: EmojiVariant) => void;
  onDismiss: () => void;
}

/**
 * Всплывающий выбор оформления для только что вставленного смайлика — по
 * образцу Телеграма: набор по умолчанию (обычно Apple) подставляется сразу,
 * а этот попап предлагает явно заменить его на другое загруженное оформление
 * того же самого Unicode-символа (Google Fonts, анимация и т.п.), если оно
 * есть. Выбор — не косметика: он остаётся в самом сообщении (см.
 * emojiVariantToken в utils/customEmoji.ts) и одинаково виден всем в
 * переписке, а не только тому, кто печатал.
 *
 * Ничего не выбирать — совершенно нормальный исход: попап сам не отправляет
 * сообщение и не блокирует набор текста, а просто закрывается по клику мимо,
 * Escape или следующему действию в поле ввода — сообщение в этом случае
 * уходит с тем оформлением по умолчанию, что подставилось сразу при вставке.
 */
const EmojiVariantPopup: React.FC<Props> = ({ variants, currentFilePath, anchorRect, onPick, onDismiss }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (ref.current?.contains(event.target as Node)) return;
      dismissLayerWithoutUnderlayActivation(event, onDismiss);
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('mousedown', closeOutside, true);
    window.addEventListener('touchstart', closeOutside, { capture: true, passive: false });
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('mousedown', closeOutside, true);
      window.removeEventListener('touchstart', closeOutside, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: anchorRect.left + anchorRect.width / 2,
    top: anchorRect.top,
  };

  return (
    <div className="emoji-variant-popup" style={style} ref={ref} role="listbox" aria-label="Выбор оформления смайлика">
      {variants.map((variant) => (
        <button
          key={variant.packKey}
          type="button"
          role="option"
          aria-selected={variant.filePath === currentFilePath}
          className={'emoji-variant-option' + (variant.filePath === currentFilePath ? ' is-current' : '')}
          title={variant.packName}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(variant)}
        >
          <img src={resolveUploadUrl(variant.filePath) || ''} alt={variant.packName} draggable={false} />
        </button>
      ))}
    </div>
  );
};

export default EmojiVariantPopup;
