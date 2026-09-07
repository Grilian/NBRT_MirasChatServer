import React, { useState } from 'react';

export interface DeleteRequest {
  ids: number[];
  /** Личная переписка — имя собеседника для галочки «Также удалить для …». */
  partnerName: string | null;
  /** Может ли этот человек убрать эти сообщения у всех (решает сервер тоже). */
  canDeleteForEveryone: boolean;
  /** Групповой чат — предупреждаем, что удаление затронет всех участников. */
  isGroup: boolean;
}

interface DeleteMessagesModalProps {
  request: DeleteRequest;
  onCancel: () => void;
  onConfirm: (forEveryone: boolean) => void;
}

const DeleteMessagesModal: React.FC<DeleteMessagesModalProps> = ({ request, onCancel, onConfirm }) => {
  const { ids, partnerName, canDeleteForEveryone, isGroup } = request;

  // В группе выбора нет: либо удаляем у всех (владелец/администрация), либо
  // только у себя. Галочка с выбором — история про личную переписку, где
  // получатель ровно один и его можно назвать по имени.
  const [forEveryone, setForEveryone] = useState(false);

  const many = ids.length > 1;
  const title = many ? `Удалить сообщения (${ids.length})` : 'Удалить сообщение';

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">{title}</div></div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="confirm-body">
          {isGroup && canDeleteForEveryone && (
            <p className="confirm-warning">
              Вы точно хотите удалить {many ? 'сообщения' : 'сообщение'} для всех участников чата?
            </p>
          )}

          {isGroup && !canDeleteForEveryone && (
            <p className="confirm-text">
              {many ? 'Сообщения пропадут' : 'Сообщение пропадёт'} только у вас — у остальных
              участников {many ? 'они останутся' : 'оно останется'} на месте.
            </p>
          )}

          {!isGroup && (
            <>
              <p className="confirm-text">
                {many ? 'Сообщения пропадут' : 'Сообщение пропадёт'} у вас.
                {canDeleteForEveryone && partnerName ? ' Чтобы убрать и у собеседника, отметьте пункт ниже.' : ''}
              </p>
              {canDeleteForEveryone && partnerName && (
                <label className="confirm-check">
                  <input
                    type="checkbox"
                    checked={forEveryone}
                    onChange={(e) => setForEveryone(e.target.checked)}
                  />
                  Также удалить для {partnerName}
                </label>
              )}
            </>
          )}
        </div>

        <div className="confirm-actions">
          <button type="button" className="sa-btn-ghost" onClick={onCancel}>Отмена</button>
          <button
            type="button"
            className="sa-btn-danger"
            onClick={() => onConfirm(isGroup ? canDeleteForEveryone : forEveryone)}
          >
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteMessagesModal;
