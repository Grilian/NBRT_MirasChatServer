export type TaskStatus = 'not_started' | 'in_progress' | 'done';

export const TASK_STATUS_ORDER: TaskStatus[] = ['not_started', 'in_progress', 'done'];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Не начата',
  in_progress: 'В работе',
  done: 'Готово',
};

export interface TaskPerson {
  id: number;
  username: string;
  display_name: string;
  avatar_path: string | null;
}

export interface TaskItem {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  created_by: TaskPerson;
  participants: TaskPerson[];
  /** Может редактировать/удалить/переставить причастных — только создатель. */
  can_edit: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  due_at: number | null;
  participant_ids: number[];
}
