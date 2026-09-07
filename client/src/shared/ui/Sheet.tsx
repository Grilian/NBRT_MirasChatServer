import React from 'react';
import { useDismissibleLayer } from './useDismissibleLayer';

/**
 * Шторка снизу.
 *
 * Нужна там, где список коротких пунктов не стоит превращать в отдельный
 * экран: «Ещё» в нижней навигации, выбор действия, короткий выбор из списка.
 * Тянется от нижнего края, потому что палец там и находится — центрированное
 * окно на телефоне заставляет тянуться к середине экрана.
 *
 * Обвязку (Escape, аппаратный «Назад», режим клавиатуры) держит общий хук,
 * тот же, что у окна.
 */
interface SheetProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Заголовок шторки. Без него остаётся только полоска-ручка. */
  title?: React.ReactNode;
  className?: string;
  label?: string;
}

const Sheet: React.FC<SheetProps> = ({ onClose, children, title, className = '', label }) => {
  useDismissibleLayer(onClose);

  return (
    <div className="sheet-overlay" onClick={onClose} role="presentation">
      <div
        className={'sheet-card ' + className}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label || (typeof title === 'string' ? title : undefined)}
      >
        {/* Полоска-ручка: она не кнопка и ничего не делает — это признак того,
            что панель пришла снизу и туда же уйдёт. Убери её, и шторка
            читается как приклеенная к экрану панель. */}
        <div className="sheet-grip" aria-hidden="true" />
        {title && <div className="sheet-title">{title}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
};

export default Sheet;
