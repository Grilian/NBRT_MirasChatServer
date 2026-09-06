import React, { useEffect, useRef } from 'react';
import { resolveUploadUrl } from '../utils/uploads';
import { dismissLayerWithoutUnderlayActivation } from '../utils/dismissLayer';

/**
 * Один пункт всплывающего ряда. Намеренно без привязки к тому, ЧЕМ пункты
 * отличаются: сейчас попап обслуживает два разных вопроса — «каким набором
 * показать этот смайлик» (композер) и «какой тон кожи взять» (панель выбора).
 * Вопросы разные, а ряд картинок с подсветкой текущей — один и тот же, и
 * вторая копия этих же тридцати строк разъехалась бы с оригиналом на первой
 * же правке (та же причина, что у общего хука useDragReorder).
 */
export interface EmojiPopupOption {
  key: string;
  label: string;
  filePath: string;
}

interface Props {
  options: EmojiPopupOption[];
  /** Путь картинки, которая уже выбрана — подсвечиваем её как текущую. */
  currentFilePath?: string;
  /** Прямоугольник якоря в системе координат окна — попап встаёт над ним. */
  anchorRect: DOMRect;
  ariaLabel?: string;
  onPick: (key: string) => void;
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
const EmojiVariantPopup: React.FC<Props> = ({
  options, currentFilePath, anchorRect, ariaLabel, onPick, onDismiss,
}) => {
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
    <div
      className="emoji-variant-popup"
      style={style}
      ref={ref}
      role="listbox"
      aria-label={ariaLabel || 'Выбор оформления смайлика'}
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="option"
          aria-selected={option.filePath === currentFilePath}
          className={'emoji-variant-option' + (option.filePath === currentFilePath ? ' is-current' : '')}
          title={option.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(option.key)}
        >
          <img src={resolveUploadUrl(option.filePath) || ''} alt={option.label} draggable={false} />
        </button>
      ))}
    </div>
  );
};

export default EmojiVariantPopup;
