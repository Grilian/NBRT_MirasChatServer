import React, { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { dayKeyOf, formatDayLong, instantOf, toDateInput } from '../calendar/dates';
import { nameFor } from '../utils/user';
import { TASK_STATUS_LABELS, TASK_STATUS_ORDER, TaskDraft, TaskItem, TaskPerson, TaskStatus } from './types';

interface DirectoryEntry {
  id: number;
  username: string;
  display_name: string | null;
}

interface TaskDialogProps {
  task: TaskItem | null;
  currentUserId: number;
  onClose: () => void;
  onSave: (draft: TaskDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
  onStatusChange?: (status: TaskStatus) => Promise<void>;
  onArchiveChange?: (archived: boolean) => Promise<void>;
}

// Срок — конец дня по Москве: задача «на сегодня» просрочена только после
// полуночи, а не в любой момент после полудня.
const END_OF_DAY_MINUTES = 23 * 60 + 59;

const TaskDialog: React.FC<TaskDialogProps> = ({ task, currentUserId, onClose, onSave, onDelete, onStatusChange, onArchiveChange }) => {
  // Править задачу может только тот, кто её поставил. Раньше форма
  // показывалась всем причастным одинаково, и «Сохранить» у них упиралось в
  // 404 «Задача не найдена» — сервер такой запрос и не должен принимать,
  // ошибка была в том, что кнопку вообще показывали. Причастный видит
  // карточку задачи, а меняет только статус — из списка.
  const readOnly = !!task && !task.can_edit;
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [dueDate, setDueDate] = useState(task?.due_at ? toDateInput(task.due_at) : '');
  const [participants, setParticipants] = useState<TaskPerson[]>(task?.participants || []);
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<TaskStatus | null>(task?.status || null);
  const [changingStatus, setChangingStatus] = useState(false);
  const [archived, setArchived] = useState(task?.archived || false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    api.get('/users').then(({ data }) => setPeople(data)).catch(() => {});
  }, []);

  const changeStatus = async (next: TaskStatus) => {
    if (!onStatusChange || next === status || changingStatus) return;
    const prev = status;
    setStatus(next);
    setChangingStatus(true);
    try {
      await onStatusChange(next);
    } catch {
      setStatus(prev);
    } finally {
      setChangingStatus(false);
    }
  };

  const statusPicker = task && onStatusChange && (
    <div className="field">
      <label>Статус</label>
      <div className="task-status-picker">
        {TASK_STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={'task-status-pill' + (s === status ? ' is-active is-' + s : '')}
            disabled={changingStatus}
            onClick={() => changeStatus(s)}
          >
            {TASK_STATUS_LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  );

  const toggleArchive = async () => {
    if (!onArchiveChange || archiving) return;
    const next = !archived;
    setArchiving(true);
    try {
      await onArchiveChange(next);
      setArchived(next);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось изменить архив');
    } finally {
      setArchiving(false);
    }
  };

  // Архивировать можно только завершённую — и не раньше, чем сохранится
  // текущий статус, иначе можно было бы отправить в архив ещё не сделанную
  // задачу мимо серверной проверки, просто раньше кликнув сюда.
  const archiveButton = task && onArchiveChange && (status === 'done' || archived) && (
    <div className="field task-archive-field">
      <button type="button" className="sa-btn-ghost task-archive-toggle" onClick={toggleArchive} disabled={archiving}>
        {archived ? 'Вернуть из архива' : 'Перенести в архив'}
      </button>
    </div>
  );

  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const pickedIds = new Set(participants.map((p) => p.id));
    return people
      .filter((p) => p.id !== currentUserId && !pickedIds.has(p.id))
      .filter((p) => nameFor(p).toLowerCase().includes(needle) || p.username.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [people, query, participants, currentUserId]);

  const addParticipant = (person: DirectoryEntry) => {
    setParticipants((prev) => [...prev, {
      id: person.id, username: person.username,
      display_name: person.display_name || person.username, avatar_path: null,
    }]);
    setQuery('');
  };

  const removeParticipant = (id: number) => {
    setParticipants((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) { setError('Укажите название'); return; }

    setSaving(true);
    setError('');
    try {
      await onSave({
        title: trimmed,
        description: description.trim(),
        due_at: dueDate ? instantOf(dueDate, END_OF_DAY_MINUTES) : null,
        participant_ids: participants.map((p) => p.id),
      });
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card task-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">{task ? 'Задача' : 'Новая задача'}</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {readOnly ? (
          <div className="task-dialog-body">
            <div className="task-view-title">{task!.title}</div>
            {task!.description && <p className="task-view-note">{task!.description}</p>}
            <div className="task-view-row">Поставил: {nameFor(task!.created_by)}</div>
            {task!.due_at !== null && (
              <div className="task-view-row">Срок: {formatDayLong(dayKeyOf(task!.due_at))}</div>
            )}
            {task!.participants.length > 0 && (
              <div className="task-view-row">
                Причастные: {task!.participants.map((p) => nameFor(p)).join(', ')}
              </div>
            )}
            {statusPicker}
            {archiveButton}
          </div>
        ) : (
        <form onSubmit={handleSave} className="task-dialog-body">
          {error && <p className="form-error">{error}</p>}

          {statusPicker}
          {archiveButton}

          <div className="field">
            <label>Название</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} />
          </div>

          <div className="field">
            <label>Описание</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000} />
          </div>

          <div className="field">
            <label>Срок (необязательно)</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>

          <div className="field">
            <label>Причастные</label>
            <div className="task-participants-picked">
              {participants.map((p) => (
                <span key={p.id} className="task-chip">
                  {nameFor(p)}
                  <button type="button" onClick={() => removeParticipant(p.id)} aria-label="Убрать">×</button>
                </span>
              ))}
              {participants.length === 0 && <span className="task-hint">Пока никого — задачу увидите только вы</span>}
            </div>
            <div className="task-people-search">
              <input
                type="text"
                placeholder="Добавить человека…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {suggestions.length > 0 && (
                <div className="task-suggest-list">
                  {suggestions.map((p) => (
                    <button type="button" key={p.id} className="task-suggest-row" onClick={() => addParticipant(p)}>
                      {nameFor(p)} <span className="cal-suggest-count">@{p.username}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="task-dialog-actions">
            {task?.can_edit && onDelete && (
              <button type="button" className="cal-dialog-delete" onClick={onDelete}>Удалить</button>
            )}
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};

export default TaskDialog;
