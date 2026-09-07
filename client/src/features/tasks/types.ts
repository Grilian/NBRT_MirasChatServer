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

/**
 * Откуда задача взялась.
 *
 * `manual` — завели руками, `chat` — из сообщения в переписке. `order` (заказ
 * книг) есть в схеме сервера, но НЕ используется: внешней базы пока нет даже в
 * договорённостях, и сервер такой источник молча приводит к `manual`. Тип
 * оставлен, чтобы карточка и журнал не переделывались, когда заказы появятся.
 */
export type TaskSourceKind = 'manual' | 'chat' | 'order';

export interface TaskSource {
  kind: TaskSourceKind;
  /** Ключ внутри источника: chat_id у задачи из чата, номер у заказа. */
  ref: string | null;
  /** Имя источника КОПИЕЙ на момент создания: чат могут переименовать. */
  label: string | null;
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
  /**
   * Ответственный. Один и передаваемый: «задача может перемещаться от
   * исполнителя к исполнителю». `null` — ещё никому не поручена, и тогда её
   * видят все причастные, иначе взять её было бы некому.
   */
  assignee: TaskPerson | null;
  participants: TaskPerson[];
  source: TaskSource;
  /** Может редактировать/переставить причастных — только создатель. */
  can_edit: boolean;
  /** Передать задачу: постановщик или текущий исполнитель. */
  can_assign: boolean;
  archived: boolean;
  deleted?: boolean;
}

/** Строка журнала удалений: та же задача плюс обстоятельства удаления. */
export interface TaskJournalEntry extends TaskItem {
  deleted_at: number;
  deleted_by: TaskPerson | null;
  delete_reason: string | null;
  /** Статус НА МОМЕНТ удаления, а не текущий. */
  deleted_status: TaskStatus;
}

export interface TaskDraft {
  title: string;
  description: string;
  due_at: number | null;
  participant_ids: number[];
  assignee_id?: number | null;
  source_kind?: TaskSourceKind;
  source_ref?: string | null;
  source_label?: string | null;
}
