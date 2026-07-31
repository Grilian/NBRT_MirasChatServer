import React, { useEffect, useState } from 'react';
import { dayKeyOf, formatDayLong, todayKey } from '../calendar/dates';
import { nameFor } from '../utils/user';
import { createTask, deleteTask, fetchTasks, setTaskStatus, updateTask } from './api';
import TaskDialog from './TaskDialog';
import { TaskItem, TaskStatus } from './types';

interface TasksPanelProps {
  currentUserId: number;
  /**
   * Меняется, когда сервер сообщил, что задачи изменились (событие
   * 'tasks_changed'). Без этого статус, поставленный другим причастным, не
   * появлялся на экране, пока не переключишь вкладку и список не
   * перезапросится сам.
   */
  changeToken?: number;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Не начата',
  in_progress: 'В работе',
  done: 'Готово',
};

const STATUS_ORDER: TaskStatus[] = ['not_started', 'in_progress', 'done'];

type Tab = 'mine' | 'authored';

function dueLabel(task: TaskItem): { text: string; overdue: boolean } | null {
  if (task.due_at === null) return null;
  const overdue = task.status !== 'done' && dayKeyOf(task.due_at) < todayKey();
  return { text: formatDayLong(dayKeyOf(task.due_at)), overdue };
}

const TasksPanel: React.FC<TasksPanelProps> = ({ currentUserId, changeToken = 0 }) => {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('mine');
  const [editing, setEditing] = useState<TaskItem | null | 'new'>(null);

  const load = () => {
    setLoading(true);
    fetchTasks()
      .then((data) => { setTasks(data); setError(false); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [changeToken]);

  const mine = tasks.filter((t) => t.created_by.id !== currentUserId);
  const authored = tasks.filter((t) => t.created_by.id === currentUserId);
  const list = tab === 'mine' ? mine : authored;

  const cycleStatus = async (task: TaskItem) => {
    const nextIndex = (STATUS_ORDER.indexOf(task.status) + 1) % STATUS_ORDER.length;
    const next = STATUS_ORDER[nextIndex];
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
    try {
      await setTaskStatus(task.id, next);
    } catch {
      load(); // откатываем оптимистичное изменение, перечитав с сервера
    }
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
      </div>

      <div className="section-scroll">
        <div className="section-column">
          {error && <div className="roster-empty">Не удалось загрузить задачи</div>}
          {!loading && !error && list.length === 0 && (
            <div className="roster-empty">
              {tab === 'mine' ? 'Пока никто не поручил вам задачу' : 'Вы ещё не ставили задач'}
            </div>
          )}

          {list.map((task) => {
            const due = dueLabel(task);
            const otherPerson = tab === 'mine' ? task.created_by : null;
            return (
              <div key={task.id} className={'task-row' + (task.status === 'done' ? ' is-done' : '')}>
                <button
                  type="button"
                  className={`task-status-pill is-${task.status}`}
                  onClick={() => cycleStatus(task)}
                  title="Сменить статус"
                >
                  {STATUS_LABELS[task.status]}
                </button>

                <div className="task-row-body" onClick={() => setEditing(task)} role="button" tabIndex={0}>
                  <div className="task-row-title">{task.title}</div>
                  <div className="task-row-meta">
                    {otherPerson && <span>от {nameFor(otherPerson)}</span>}
                    {tab === 'authored' && task.participants.length > 0 && (
                      <span>{task.participants.map((p) => nameFor(p)).join(', ')}</span>
                    )}
                    {tab === 'authored' && task.participants.length === 0 && <span className="task-hint">только для вас</span>}
                    {due && <span className={due.overdue ? 'task-due is-overdue' : 'task-due'}>до {due.text}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editing !== null && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          currentUserId={currentUserId}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          onDelete={editing !== 'new' && editing?.can_edit ? handleDelete : undefined}
        />
      )}
    </div>
  );
};

export default TasksPanel;
