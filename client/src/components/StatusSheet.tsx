import React from 'react';
import StatusPicker from './StatusPicker';

interface StatusSheetProps {
  statusPreset: string | null;
  statusCustom: string | null;
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
  statusPreset, statusCustom, onStatusChanged, onClose,
}) => (
  <div className="modal-overlay modal-overlay-nested" onClick={onClose}>
    <div className="modal-card status-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="conv-head">
        <div className="conv-title"><div className="settings-title">Статус</div></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="status-sheet-body">
        <StatusPicker
          statusPreset={statusPreset}
          statusCustom={statusCustom}
          onStatusChanged={onStatusChanged}
          onDone={onClose}
        />
      </div>
    </div>
  </div>
);

export default StatusSheet;
