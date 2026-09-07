// Ветки.

import api from '@/shared/api/client';
import type { ThreadInboxItem, ThreadSummary } from '@/shared/api/thread';

/** Список веток, к которым человек причастен: свой корень либо свой ответ. */
export async function fetchThreadInbox(): Promise<ThreadInboxItem[]> {
  const { data } = await api.get<ThreadInboxItem[]>('/messages/threads');
  return data;
}

/**
 * Сводка одной ветки.
 *
 * Считается ПОД КОНКРЕТНОГО ЗРИТЕЛЯ (`unread_count`), поэтому в широковещательном
 * `thread_summary_changed` её нет — там только `root_id`, а сводку каждый
 * перезапрашивает сам.
 */
export async function fetchThreadSummary(rootId: number): Promise<ThreadSummary> {
  const { data } = await api.get<ThreadSummary>(`/messages/threads/${rootId}/summary`);
  return data;
}
