import api from '../api/client';
import { TaskDraft, TaskItem, TaskStatus } from './types';

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

export async function deleteTask(id: number): Promise<void> {
  await api.delete(`/tasks/${id}`);
}

export async function setTaskArchived(id: number, archived: boolean): Promise<TaskItem> {
  const { data } = await api.put(`/tasks/${id}/archive`, { archived });
  return data;
}
