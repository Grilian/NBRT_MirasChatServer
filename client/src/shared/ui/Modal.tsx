import React from 'react';
import { useDismissibleLayer } from './useDismissibleLayer';

/**
 * Окно поверх приложения.
 *
 * Пятнадцать компонентов повторяли одну и ту же обвязку: наложение, карточка,
 * закрытие по клику мимо, `stopPropagation` внутри, кнопка-крестик. Дальше
 * начинались расхождения — и это не мелочь, потому что забывалась каждый раз
 * РАЗНАЯ вещь:
 *
 * - **Режим клавиатуры Android.** Пока открыта переписка, приложение держит
 *   `adjustNothing`: композер двигает себя сам. Окно поверх неё об этом не
 *   знает, WebView под клавиатуру не сжимается, а наложение растянуто на весь
 *   экран — центрированная карточка остаётся по центру ЭКРАНА, и её низ
 *   уходит под клавиатуру. Ровно там, где обычно стоит поле поиска. Часть
 *   окон брала штатный режим, часть — нет.
 * - **Аппаратный «Назад».** Не встроенное в цепочку окно закрывалось не
 *   первым: Back уводил экран из-под него, а само окно оставалось висеть
 *   поверх уже другого экрана.
 * - **Escape.** Работал у меньшинства.
 *
 * Теперь всё это принадлежит окну, а не каждому его виду по отдельности.
 */
interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Класс карточки — у окон разная ширина и внутренняя раскладка. */
  className?: string;
  /**
   * Окно поверх УЖЕ открытого окна (профиль поверх справочника).
   *
   * Одного z-index мало: при равном значении порядок в DOM решает, кто сверху,
   * а не то, какое окно открыли позже.
   */
  nested?: boolean;
  /**
   * Клик мимо карточки не закрывает.
   *
   * Для окон, где закрытие теряет введённое: создание опроса, правка события.
   * Промах мимо карточки не должен стирать работу.
   */
  persistent?: boolean;
  /** Подпись для экранных читалок, когда в шапке нет видимого заголовка. */
  label?: string;
  /**
   * На узком экране это не карточка посреди экрана, а СТРАНИЦА во весь экран.
   *
   * Так по концепции устроены Контакты, Настройки и Профиль: на широком окне
   * их открывают, чтобы глянуть и вернуться к делу, — там окно; на телефоне
   * карточка с полями посреди экрана превращается в щель между клавиатурой и
   * верхним краем, и правильнее занять экран целиком.
   */
  pageOnMobile?: boolean;
}

const Modal: React.FC<ModalProps> = ({
  onClose, children, className = '', nested = false, persistent = false, label,
  pageOnMobile = false,
}) => {
  useDismissibleLayer(onClose);

  return (
    <div
      className={'modal-overlay'
        + (nested ? ' modal-overlay-nested' : '')
        + (pageOnMobile ? ' mobile-page-overlay' : '')}
      onClick={persistent ? undefined : onClose}
      role="presentation"
    >
      <div
        className={'modal-card ' + className}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
};

/** Шапка окна: заголовок, необязательный подзаголовок и крестик. */
export const ModalHead: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** Действия слева от крестика — например «Создать». */
  actions?: React.ReactNode;
}> = ({ title, subtitle, onClose, actions }) => (
  <div className="conv-head">
    <div className="conv-title">
      <div className="settings-title">{title}</div>
      {subtitle && <div className="status">{subtitle}</div>}
    </div>
    {actions}
    <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  </div>
);

export default Modal;
