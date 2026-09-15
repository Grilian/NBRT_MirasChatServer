import api from '@/shared/api/client';

export type TraceKind = 'all' | 'messages' | 'files' | 'images' | 'links' | 'notes';

/**
 * Состояние следа считается СЕРВЕРОМ в момент запроса, а не запоминается при
 * сохранении: источник могли удалить, скрыть или закрыть доступ, и клиенту
 * решать это нечем — у него нет ни прав, ни содержимого.
 */
export type TraceState = 'ok' | 'cleaned' | 'hidden' | 'forbidden';

export interface TraceItem {
  origin_message_id: number;
  origin_chat_id: string;
  note: string | null;
  created_at: number;
  kind: Exclude<TraceKind, 'all' | 'notes'>;
  state: TraceState;
  /** Дальше — только для state === 'ok': содержимое закрытого не приходит вовсе. */
  chat?: { id: string; name: string; kind: string; avatar_path: string | null };
  author?: string;
  text?: string;
  file_path?: string | null;
  document_name?: string | null;
  attachment_archived?: boolean;
  message_created_at?: string;
  /** Для 'cleaned' — если известно, кто подчистил. */
  deleted_by_name?: string | null;
}

export interface TraceOrigin {
  state: TraceState;
  chat_id?: string;
  message_id?: number;
  thread_root_id?: number | null;
}

export async function fetchTraces(kind: TraceKind): Promise<TraceItem[]> {
  const { data } = await api.get(`/traces?kind=${kind}`);
  return data.items || [];
}

export async function saveTraceNote(messageId: number, note: string): Promise<string | null> {
  const { data } = await api.put(`/traces/${messageId}/note`, { note });
  return data.note ?? null;
}

/** Куда вести по «Найти след» — и почему вести некуда, если некуда. */
export async function fetchTraceOrigin(messageId: number): Promise<TraceOrigin> {
  const { data } = await api.get(`/traces/${messageId}/origin`);
  return data;
}
