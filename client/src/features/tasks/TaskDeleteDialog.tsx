import React, { useState } from 'react';
import Modal, { ModalHead } from '@/shared/ui/Modal';

/**
 * Удаление задачи с обязательной причиной.
 *
 * Отдельным окном, а не `window.confirm`: причину нужно ввести, а не
 * подтвердить, и она обязательна. Удалить задачу может ЛЮБОЙ причастный —
 * значит она может исчезнуть у постановщика без его ведома, и запись в журнале
 * тут единственное, что объяснит ему, куда она делась. Пустая причина
 * заполнила бы журнал строками, по которым ничего не понять.
 */
const TaskDeleteDialog: React.FC<{
  title: string;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}> = ({ title, onCancel, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmed = reason.trim();

  const submit = async () => {
    if (!trimmed) {
      setError('Без причины удалить нельзя — её увидит постановщик в журнале.');
      return;
    }
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } catch {
      setError('Не удалось удалить задачу');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} nested className="task-delete-modal" persistent>
      <ModalHead title="Удалить задачу" subtitle={title} onClose={onCancel} />
      <div className="task-delete-body">
        <label className="task-delete-label" htmlFor="task-delete-reason">
          Причина удаления
        </label>
        <textarea
          id="task-delete-reason"
          className="task-delete-input"
          value={reason}
          maxLength={200}
          rows={3}
          autoFocus
          placeholder="Например: создан дубль, заказ отменён читателем"
          onChange={(e) => { setReason(e.target.value); setError(''); }}
        />
        <p className="task-delete-note">
          Задача не пропадёт бесследно: она останется в журнале с этой причиной,
          и её можно будет вернуть.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="task-modal-actions">
          <button type="button" className="sa-btn-ghost" onClick={onCancel} disabled={busy}>Отмена</button>
          <button type="button" className="sa-btn-danger" onClick={submit} disabled={busy || !trimmed}>
            Удалить
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default TaskDeleteDialog;
