import React, { useEffect, useState } from 'react';
import { dayKeyOf, formatDayLong, todayKey } from '../calendar/dates';
import { nameFor } from '../utils/user';
import { createTask, deleteTask, fetchTasks, setTaskArchived, setTaskStatus, updateTask } from './api';
import TaskDialog from './TaskDialog';
import { TASK_STATUS_LABELS, TASK_STATUS_ORDER, TaskItem, TaskStatus } from './types';

interface TasksPanelProps {
  currentUserId: number;
  /**
   * Меняется, когда сервер сообщил, что задачи изменились (событие
   * 'tasks_changed'). Без этого статус, поставленный другим причастным, не
   * появлялся на экране, пока не переключишь вкладку и список не
   * перезапросится сам.
   */
  changeToken?: number;
  /**
   * Текст сообщения, из которого просят завести задачу (пункт «Создать
   * задачу» в переписке). Приходит вместе с переходом в раздел — сразу
   * открываем диалог новой задачи с этим текстом в описании.
   */
  draftDescription?: string | null;
  onDraftConsumed?: () => void;
}

const STATUS_LABELS = TASK_STATUS_LABELS;
const STATUS_ORDER = TASK_STATUS_ORDER;

type Tab = 'mine' | 'authored' | 'archive';

function dueLabel(task: TaskItem): { text: string; overdue: boolean } | null {
  if (task.due_at === null) return null;
  const overdue = task.status !== 'done' && dayKeyOf(task.due_at) < todayKey();
  return { text: formatDayLong(dayKeyOf(task.due_at)), overdue };
}

const TasksPanel: React.FC<TasksPanelProps> = ({
  currentUserId, changeToken = 0, draftDescription = null, onDraftConsumed
}) => {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('mine');
  const [editing, setEditing] = useState<TaskItem | null | 'new'>(null);

  const load = () => {
    setLoading(true);
    Promise.all([fetchTasks(false), fetchTasks(true)])
      .then(([active, archived]) => { setTasks(active); setArchivedTasks(archived); setError(false); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [changeToken]);

  // Пришли из переписки с текстом сообщения — открываем новую задачу сразу.
  useEffect(() => {
    if (draftDescription) setEditing('new');
  }, [draftDescription]);

  const mine = tasks.filter((t) => t.created_by.id !== currentUserId);
  const authored = tasks.filter((t) => t.created_by.id === currentUserId);
  const list = tab === 'mine' ? mine : tab === 'authored' ? authored : archivedTasks;

  const changeStatus = async (taskId: number, next: TaskStatus) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: next } : t)));
    try {
      await setTaskStatus(taskId, next);
    } catch (e) {
      load(); // откатываем оптимистичное изменение, перечитав с сервера
      throw e;
    }
  };

  const cycleStatus = (task: TaskItem) => {
    const nextIndex = (STATUS_ORDER.indexOf(task.status) + 1) % STATUS_ORDER.length;
    changeStatus(task.id, STATUS_ORDER[nextIndex]).catch(() => {});
  };

  const archiveTask = async (task: TaskItem, archived: boolean) => {
    await setTaskArchived(task.id, archived);
    load();
  };

  const handleSave = async (draft: Parameters<typeof createTask>[0]) => {
    if (editing === 'new') await createTask(draft);
    else if (editing) await updateTask(editing.id, draft);
    load();
  };

  const handleDelete = async () => {
    if (editing === 'new' || !editing) return;
    if (!window.confirm(`Удалить задачу «${editing.title}»?`)) return;
    await deleteTask(editing.id);
    setEditing(null);
    load();
  };

  return (
    <div className="section-pane">
      <div className="conv-head">
        <div className="conv-title">
          <div className="name">Задачи</div>
          <div className="status">{loading ? 'Загрузка…' : `${list.length} шт.`}</div>
        </div>
        <button type="button" className="btn-primary task-create-btn" onClick={() => setEditing('new')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
          Задача
        </button>
      </div>

      <div className="task-tabs">
        <button type="button" className={'task-tab' + (tab === 'mine' ? ' is-active' : '')} onClick={() => setTab('mine')}>
          Мне {mine.length > 0 && <span className="task-tab-count">{mine.length}</span>}
        </button>
        <button type="button" className={'task-tab' + (tab === 'authored' ? ' is-active' : '')} onClick={() => setTab('authored')}>
          От меня {authored.length > 0 && <span className="task-tab-count">{authored.length}</span>}
        </button>
        <button type="button" className={'task-tab' + (tab === 'archive' ? ' is-active' : '')} onClick={() => setTab('archive')}>
          Архив {archivedTasks.length > 0 && <span className="task-tab-count">{archivedTasks.length}</span>}
        </button>
      </div>

      <div className="section-scroll">
        <div className="section-column">
          {error && <div className="roster-empty">Не удалось загрузить задачи</div>}
          {!loading && !error && list.length === 0 && (
            <div className="roster-empty">
              {tab === 'mine' && 'Пока никто не поручил вам задачу'}
              {tab === 'authored' && 'Вы ещё не ставили задач'}
              {tab === 'archive' && 'Архив пуст'}
            </div>
          )}

          {list.map((task) => {
            const due = dueLabel(task);
            const otherPerson = task.created_by.id !== currentUserId ? task.created_by : null;
            return (
              <div key={task.id} className={'task-row' + (task.status === 'done' ? ' is-done' : '')}>
                <button
                  type="button"
                  className={`task-status-pill is-${task.status}`}
                  onClick={() => cycleStatus(task)}
                  title="Сменить статус"
                  disabled={tab === 'archive'}
                >
                  {STATUS_LABELS[task.status]}
                </button>

                <div className="task-row-body" onClick={() => setEditing(task)} role="button" tabIndex={0}>
                  <div className="task-row-title">{task.title}</div>
                  <div className="task-row-meta">
                    {otherPerson && <span>от {nameFor(otherPerson)}</span>}
                    {!otherPerson && task.participants.length > 0 && (
                      <span>{task.participants.map((p) => nameFor(p)).join(', ')}</span>
                    )}
                    {!otherPerson && task.participants.length === 0 && <span className="task-hint">только для вас</span>}
                    {due && <span className={due.overdue ? 'task-due is-overdue' : 'task-due'}>до {due.text}</span>}
                  </div>
                </div>

                {tab === 'archive' ? (
                  <button type="button" className="icon-btn-ghost task-archive-btn" title="Вернуть из архива" onClick={() => archiveTask(task, false).catch(console.error)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M11 6l-6 6 6 6" /></svg>
                  </button>
                ) : task.status === 'done' && (
                  <button type="button" className="icon-btn-ghost task-archive-btn" title="В архив" onClick={() => archiveTask(task, true).catch(console.error)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" /></svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {editing !== null && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          currentUserId={currentUserId}
          initialDescription={editing === 'new' ? (draftDescription || undefined) : undefined}
          onClose={() => { setEditing(null); onDraftConsumed?.(); }}
          onSave={handleSave}
          onDelete={editing !== 'new' && editing?.can_edit ? handleDelete : undefined}
          onStatusChange={editing !== 'new' && editing && !editing.archived ? (status) => changeStatus(editing.id, status) : undefined}
          onArchiveChange={editing !== 'new' && editing ? (archived) => archiveTask(editing, archived) : undefined}
        />
      )}
    </div>
  );
};

export default TasksPanel;
