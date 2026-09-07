import React from 'react';
import Modal from '@/shared/ui/Modal';
import StatusPicker from './StatusPicker';
import { CustomEmojiMap } from '@/features/emoji/customEmoji';

interface StatusSheetProps {
  statusPreset: string | null;
  statusCustom: string | null;
  customEmoji?: CustomEmojiMap;
  onStatusChanged: (preset: string | null, custom: string | null) => void;
  onClose: () => void;
}

/**
 * Окно «только статус» — то, что открывается по тапу на свой аватар в шапке.
 * Профиль целиком сюда не тянем намеренно: до статуса раньше нужно было идти
 * через настройки и правку профиля, и вся задача была в том, чтобы этот путь
 * убрать, а не спрятать его на шаг ближе.
 */
const StatusSheet: React.FC<StatusSheetProps> = ({
  statusPreset, statusCustom, customEmoji = {}, onStatusChanged, onClose,
}) => (
  <Modal onClose={onClose} nested className="status-sheet">
    {/* Своя шапка, а не ModalHead: у неё свои размеры и подзаголовок
        (.status-sheet-head / -heading / -subtitle), и общая шапка их потеряет. */}
    <div className="conv-head status-sheet-head">
      <div className="conv-title status-sheet-heading">
        <div className="settings-title">Статус</div>
        <div className="status-sheet-subtitle">Покажите коллегам, чем вы заняты</div>
      </div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div className="status-sheet-body">
      <StatusPicker
        statusPreset={statusPreset}
        statusCustom={statusCustom}
        customEmoji={customEmoji}
        onStatusChanged={onStatusChanged}
        onDone={onClose}
      />
    </div>
  </Modal>
);

export default StatusSheet;
