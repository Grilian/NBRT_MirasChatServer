import React, { useEffect, useMemo, useState } from 'react';
import { dayKeyOf, formatDayLong, todayKey } from '@/features/calendar/dates';
import { plural } from '@/shared/lib/plural';
import { nameFor } from '@/shared/lib/user';
import Avatar from '@/shared/ui/Avatar';
import {
  createTask, deleteTask, fetchTaskJournal, fetchTasks, restoreTask,
  setTaskArchived, setTaskAssignee, setTaskStatus, updateTask,
} from './api';
import { isInvolved, isMyWork } from './scope';
import TaskDialog from './TaskDialog';
import TaskDeleteDialog from './TaskDeleteDialog';
import {
  TASK_STATUS_LABELS, TASK_STATUS_ORDER, TaskItem, TaskJournalEntry, TaskStatus,
} from './types';

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
  /**
   * С какой вкладки открыть. Приходит с «Главной»: если просроченное лежит в
   * поставленных, число оттуда обязано привести именно туда, а не на пустую
   * «Мою работу». Раздел при уходе размонтируется, поэтому значение нужно
   * только на старте.
   */
  initialTab?: 'work' | 'authored';
  /** В компактном десктопном окне задачи закрываются крестиком. */
  onClose?: () => void;
}

const STATUS_LABELS = TASK_STATUS_LABELS;
const STATUS_ORDER = TASK_STATUS_ORDER;

/**
 * Вкладки — по РОЛИ в задаче, а не по её состоянию.
 *
 * «Моя работа» и «Поставленные» отвечают на разные вопросы: «что делать мне» и
 * «что я поручил и чем это кончилось». Архив и журнал — состояния, но у них
 * своя раскладка (в архиве нет колонок, в журнале таблица), поэтому они здесь
 * же, а не отдельным переключателем.
 */
type Tab = 'work' | 'authored' | 'archive' | 'journal';

const TABS: { id: Tab; label: string }[] = [
  { id: 'work', label: 'Моя работа' },
  { id: 'authored', label: 'Поставленные' },
  { id: 'archive', label: 'Архив' },
  { id: 'journal', label: 'Журнал' },
];

function dueLabel(task: TaskItem): { text: string; overdue: boolean } | null {
  if (task.due_at === null) return null;
  const overdue = task.status !== 'done' && dayKeyOf(task.due_at) < todayKey();
  return { text: formatDayLong(dayKeyOf(task.due_at)), overdue };
}

/** Подпись источника на карточке. */
function sourceLabel(task: TaskItem): string {
  if (task.source.kind === 'chat') {
    return task.source.label ? `Из чата «${task.source.label}»` : 'Из переписки';
  }
  if (task.source.kind === 'order') {
    return task.source.ref ? `Заказ книг · № ${task.source.ref}` : 'Заказ книг';
  }
  return 'Создана вручную';
}

function whenLabel(ms: number): string {
  const day = dayKeyOf(ms);
  const time = new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${formatDayLong(day)}, ${time}`;
}

const TasksPanel: React.FC<TasksPanelProps> = ({
  currentUserId, changeToken = 0, draftDescription = null, onDraftConsumed, initialTab, onClose
}) => {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskItem[]>([]);
  const [journal, setJournal] = useState<TaskJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab || 'work');
  /**
   * «Мои» или «Все, к чему причастен».
   *
   * Без этого переключателя задача, где человек лишь наблюдатель, не попадала
   * бы НИ В ОДНУ вкладку: в «Моей работе» её нет (он не исполнитель), в
   * «Поставленных» тоже (он не автор). Видеть её он при этом вправе.
   */
  const [wideScope, setWideScope] = useState(false);
  const [editing, setEditing] = useState<TaskItem | null | 'new'>(null);
  const [deleting, setDeleting] = useState<TaskItem | null>(null);

  /**
   * Журнал грузится ОТДЕЛЬНО от списков и его падение не роняет раздел.
   *
   * Было наоборот: три запроса шли одним Promise.all, и отказ ЛЮБОГО из них
   * гасил доску целиком — вместо задач человек видел «Не удалось загрузить
   * задачи», хотя сами задачи пришли. Поймано на живой сборке против сервера,
   * где ручки журнала ещё нет: раздел выглядел полностью сломанным из-за
   * второстепенной выдачи.
   *
   * Доска и архив — то, ради чего сюда приходят, и только их отказ считается
   * отказом раздела. Журнал молча остаётся пустым: вкладка честно скажет
   * «удалённых задач нет», а не соврёт про остальное.
   */
  const load = () => {
    setLoading(true);
    Promise.all([fetchTasks(false), fetchTasks(true)])
      .then(([active, archived]) => {
        setTasks(active); setArchivedTasks(archived); setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));

    fetchTaskJournal().then(setJournal).catch(() => setJournal([]));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [changeToken]);

  // Пришли из переписки с текстом сообщения — открываем новую задачу сразу.
  useEffect(() => {
    if (draftDescription) setEditing('new');
  }, [draftDescription]);

  // «Моя работа» — то, за что спрашивают с меня: где я исполнитель, а также
  // ничьи задачи, которые я вправе взять. Переключатель «Все» расширяет до
  // всего, к чему я причастен.
  const myWork = useMemo(
    () => tasks.filter((t) => (wideScope ? isInvolved(t, currentUserId) : isMyWork(t, currentUserId))),
    [tasks, wideScope, currentUserId],
  );

  const authored = useMemo(
    () => tasks.filter((t) => t.created_by.id === currentUserId),
    [tasks, currentUserId],
  );

  const boardTasks = tab === 'work' ? myWork : authored;

  // Подпись под заголовком описывает ТО, ЧТО НА ЭКРАНЕ, а не всё подряд.
  // Раньше она считала все видимые задачи, включая поставленные другим, и
  // получалось «2 просрочено» над пустой вкладкой «Моя работа» — число, к
  // которому на этом экране не притронуться. То же расхождение нашлось между
  // «Главной» и разделом, и лечится оно одинаково: считаем ровно тот набор,
  // который человек видит.
  const overdueCount = boardTasks.filter((t) => dueLabel(t)?.overdue).length;
  const headCount = tab === 'archive' ? archivedTasks.length
    : tab === 'journal' ? journal.length
      : boardTasks.length;
  const headLabel = tab === 'archive' ? plural(headCount, 'задача в архиве', 'задачи в архиве', 'задач в архиве')
    : tab === 'journal' ? plural(headCount, 'запись', 'записи', 'записей')
      : plural(headCount, 'задача', 'задачи', 'задач');

  const changeStatus = async (taskId: number, next: TaskStatus) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: next } : t)));
    try {
      await setTaskStatus(taskId, next);
    } catch (e) {
      load(); // откатываем оптимистичное изменение, перечитав с сервера
      throw e;
    }
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

  const handleDelete = async (reason: string) => {
    if (!deleting) return;
    await deleteTask(deleting.id, reason);
    setDeleting(null);
    setEditing(null);
    load();
  };

  const handleRestore = async (entry: TaskJournalEntry) => {
    await restoreTask(entry.id);
    load();
  };

  const renderCard = (task: TaskItem) => {
    const due = dueLabel(task);
    // БЕЗ закольцовки: у «Готово» следующего статуса нет. Раньше индекс брался
    // по кругу, и на завершённой карточке висела кнопка «→ Не начата» —
    // предложение начать заново там, где работа закончена.
    const nextStatus = STATUS_ORDER[STATUS_ORDER.indexOf(task.status) + 1];
    return (
      <article key={task.id} className={'task-card' + (task.status === 'done' ? ' is-done' : '')}>
        <div className="task-card-source">{sourceLabel(task)}</div>
        <button type="button" className="task-card-main" onClick={() => setEditing(task)}>
          {/* Название не обрезается: в списке поручений оно и есть суть. */}
          <span className="task-card-title">{task.title}</span>
          {task.description && <span className="task-card-desc">{task.description}</span>}
        </button>
        <div className="task-card-foot">
          {due && (
            <span className={'task-due' + (due.overdue ? ' is-overdue' : '')}>
              {due.overdue ? 'Просрочено: ' : 'До '}{due.text}
            </span>
          )}
          {/* Исполнитель — один, и это ответ на вопрос «с кого спрос».
              Не назначен — так и написано: пустое место читалось бы как
              «данные не загрузились». */}
          {/* ИМЯ, а не только кружок аватара: доска отвечает на вопрос «с кого
              спрос», а инициалы в кружке на него не отвечают — их надо
              расшифровывать, и у двух Галин они совпадут. Поймано на личном
              тестировании: «в задачах не отображается назначенный человек». */}
          {task.assignee ? (
            <span className="task-card-assignee">
              <Avatar name={nameFor(task.assignee)} avatarPath={task.assignee.avatar_path} size="sm" />
              <span className="task-card-assignee-name">{nameFor(task.assignee)}</span>
            </span>
          ) : (
            <span className="task-card-free">Не поручена</span>
          )}
        </div>
        {tab !== 'archive' && nextStatus && (
          <button
            type="button"
            className="task-card-move"
            onClick={() => changeStatus(task.id, nextStatus).catch(() => {})}
            title={`Перенести в «${STATUS_LABELS[nextStatus]}»`}
          >
            {/* Перенос кнопкой, а не перетаскиванием: тащить карточку пальцем
                по трём колонкам на 360px невозможно, а второй способ ради
                десктопа развёл бы поведение по устройствам. */}
            → {STATUS_LABELS[nextStatus]}
          </button>
        )}
      </article>
    );
  };

  return (
    <div className="section-pane tasks-pane">
      <div className="conv-head">
        <div className="conv-title">
          <div className="name">Задачи</div>
          <div className="status">
            {loading ? 'Загрузка…' : (
              <>
                {headCount} {headLabel}
                {overdueCount > 0 && <span className="task-overdue-note"> · {overdueCount} просрочено</span>}
              </>
            )}
          </div>
        </div>
        <div className="task-head-actions">
          <button type="button" className="btn-primary task-create-btn" onClick={() => setEditing('new')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            Задача
          </button>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
      </div>

      <div className="task-tabs">
        {TABS.map((item) => {
          const count = item.id === 'work' ? myWork.length
            : item.id === 'authored' ? authored.length
              : item.id === 'archive' ? archivedTasks.length
                : journal.length;
          return (
            <button
              key={item.id}
              type="button"
              className={'task-tab' + (tab === item.id ? ' is-active' : '')}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {count > 0 && <span className="task-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'work' && (
        <div className="task-scope">
          <button
            type="button"
            className={'task-scope-btn' + (wideScope ? '' : ' is-active')}
            onClick={() => setWideScope(false)}
          >
            Мои
          </button>
          <button
            type="button"
            className={'task-scope-btn' + (wideScope ? ' is-active' : '')}
            onClick={() => setWideScope(true)}
          >
            Все, к чему причастен
          </button>
        </div>
      )}

      <div className="section-scroll">
        {error && <div className="roster-empty">Не удалось загрузить задачи</div>}

        {!error && (tab === 'work' || tab === 'authored') && (
          <div className="task-board">
            {STATUS_ORDER.map((status) => {
              const column = boardTasks.filter((t) => t.status === status);
              return (
                <section key={status} className={'task-column is-' + status}>
                  <header className="task-column-head">
                    <span className="task-column-name">{STATUS_LABELS[status]}</span>
                    <span className="task-column-count">{column.length}</span>
                  </header>
                  <div className="task-column-body">
                    {column.map(renderCard)}
                    {column.length === 0 && <div className="task-column-empty">Пусто</div>}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {!error && tab === 'archive' && (
          <div className="section-column">
            {!loading && archivedTasks.length === 0 && <div className="roster-empty">Архив пуст</div>}
            {archivedTasks.map((task) => (
              <div key={task.id} className="task-row is-done">
                <div className="task-row-body" onClick={() => setEditing(task)} role="button" tabIndex={0}>
                  <div className="task-row-title">{task.title}</div>
                  <div className="task-row-meta">
                    <span>{sourceLabel(task)}</span>
                    {task.assignee && <span>{nameFor(task.assignee)}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn-ghost task-archive-btn"
                  title="Вернуть из архива"
                  onClick={() => archiveTask(task, false).catch(console.error)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M11 6l-6 6 6 6" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {!error && tab === 'journal' && (
          <div className="section-column">
            {!loading && journal.length === 0 && (
              <div className="roster-empty">Удалённых задач нет</div>
            )}
            {journal.map((entry) => (
              <div key={entry.id} className="task-journal-row">
                <div className="task-journal-main">
                  <div className="task-journal-title">{entry.title}</div>
                  <div className="task-journal-sub">
                    {sourceLabel(entry)}
                    {entry.assignee && ` · исполнитель ${nameFor(entry.assignee)}`}
                  </div>
                </div>
                <div className="task-journal-cell">
                  <span className="task-journal-label">Последний статус</span>
                  {STATUS_LABELS[entry.deleted_status]}
                </div>
                <div className="task-journal-cell">
                  <span className="task-journal-label">Удалил</span>
                  {entry.deleted_by ? nameFor(entry.deleted_by) : '—'}
                </div>
                <div className="task-journal-cell">
                  <span className="task-journal-label">Когда</span>
                  {whenLabel(entry.deleted_at)}
                </div>
                <div className="task-journal-cell task-journal-reason">
                  <span className="task-journal-label">Причина</span>
                  {entry.delete_reason || '—'}
                </div>
                <button
                  type="button"
                  className="sa-btn-ghost task-journal-restore"
                  onClick={() => handleRestore(entry).catch(console.error)}
                >
                  Вернуть
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing !== null && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          currentUserId={currentUserId}
          initialDescription={editing === 'new' ? (draftDescription || undefined) : undefined}
          onClose={() => { setEditing(null); onDraftConsumed?.(); }}
          onSave={handleSave}
          onDelete={editing !== 'new' && editing ? () => setDeleting(editing) : undefined}
          onStatusChange={editing !== 'new' && editing && !editing.archived ? (status) => changeStatus(editing.id, status) : undefined}
          onAssigneeChange={editing !== 'new' && editing ? async (assigneeId) => {
            const saved = await setTaskAssignee(editing.id, assigneeId);
            // Перечитываем список: карточка на доске обязана показать нового
            // исполнителя сразу, а не после следующего события с сервера.
            load();
            return saved;
          } : undefined}
          onArchiveChange={editing !== 'new' && editing ? (archived) => archiveTask(editing, archived) : undefined}
        />
      )}

      {deleting && (
        <TaskDeleteDialog
          title={deleting.title}
          onCancel={() => setDeleting(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
};

export default TasksPanel;
