import api from '../api/client';
import { TaskDraft, TaskItem, TaskStatus } from './types';

export async function fetchTasks(): Promise<TaskItem[]> {
  const { data } = await api.get('/tasks');
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
