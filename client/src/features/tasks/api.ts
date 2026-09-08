import api from '@/shared/api/client';
import { TaskDraft, TaskItem, TaskJournalEntry, TaskStatus } from './types';

/**
 * Приводим задачу к нынешнему виду, даже если сервер отдал прежний.
 *
 * Это НЕ поддержка старых клиентов (она снята) — обратное: клиент способен
 * опередить сервер. Так и вышло на личном тестировании: сборка с новым
 * разделом задач смотрела на прод, где `assignee` и `source` ещё не
 * появились, и `task.source.kind` ронял отрисовку всей доски — «в задачах
 * пусто». Та же минута случается при любой выкладке, пока сервер
 * перезапускается, и белый экран в эту минуту не нужен никому.
 *
 * Значения по умолчанию честные: «источника нет» и «исполнитель не
 * назначен» — ровно то, чем задача была до появления этих полей.
 */
function normalizeTask(row: any): TaskItem {
  return {
    ...row,
    assignee: row?.assignee ?? null,
    source: row?.source ?? { kind: 'manual', ref: null, label: null },
    can_assign: row?.can_assign ?? false,
    deleted: row?.deleted ?? false,
    participants: row?.participants ?? [],
  };
}

export async function fetchTasks(archived = false): Promise<TaskItem[]> {
  const { data } = await api.get('/tasks', { params: archived ? { archived: '1' } : undefined });
  return (data || []).map(normalizeTask);
}

export async function createTask(draft: TaskDraft): Promise<TaskItem> {
  const { data } = await api.post('/tasks', draft);
  return normalizeTask(data);
}

export async function updateTask(id: number, draft: TaskDraft): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}`, draft);
  return normalizeTask(data);
}

export async function setTaskStatus(id: number, status: TaskStatus): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/status`, { status });
  return normalizeTask(data);
}

/**
 * Удаление МЯГКОЕ и с обязательной причиной: задача остаётся в журнале.
 * Причина — не формальность: удалить может любой причастный, и без неё
 * постановщик не узнает, куда делась его задача.
 */
export async function deleteTask(id: number, reason: string): Promise<void> {
  await api.delete(`/tasks/${id}`, { data: { reason } });
}

export async function fetchTaskJournal(): Promise<TaskJournalEntry[]> {
  const { data } = await api.get('/tasks/journal');
  return data;
}

export async function restoreTask(id: number): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/restore`);
  return normalizeTask(data);
}

/** Передать задачу другому. `null` — снять исполнителя. */
export async function setTaskAssignee(id: number, assigneeId: number | null): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/assignee`, { assignee_id: assigneeId });
  return normalizeTask(data);
}

export async function setTaskArchived(id: number, archived: boolean): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/archive`, { archived });
  return normalizeTask(data);
}
