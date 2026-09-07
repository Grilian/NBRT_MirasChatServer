import api from '@/shared/api/client';
import { TaskDraft, TaskItem, TaskJournalEntry, TaskStatus } from './types';

export async function fetchTasks(archived = false): Promise<TaskItem[]> {
  const { data } = await api.get('/tasks', { params: archived ? { archived: '1' } : undefined });
  return data;
}

export async function createTask(draft: TaskDraft): Promise<TaskItem> {
  const { data } = await api.post('/tasks', draft);
  return data;
}

export async function updateTask(id: number, draft: TaskDraft): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}`, draft);
  return data;
}

export async function setTaskStatus(id: number, status: TaskStatus): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/status`, { status });
  return data;
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
  return data;
}

/** Передать задачу другому. `null` — снять исполнителя. */
export async function setTaskAssignee(id: number, assigneeId: number | null): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/assignee`, { assignee_id: assigneeId });
  return data;
}

export async function setTaskArchived(id: number, archived: boolean): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/archive`, { archived });
  return data;
}
