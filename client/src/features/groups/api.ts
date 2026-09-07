// Группы и каналы-объявления.

import api from '@/shared/api/client';
import type { ChatGroupSummary } from '@/shared/api/types';

export type { ChatGroupSummary };


export async function fetchGroups(): Promise<ChatGroupSummary[]> {
  const { data } = await api.get('/groups');
  return data;
}

/** Массовое удаление в группе — доступно владельцу и орг-администрации. */
export async function deleteGroupMessages(groupId: number, ids: number[]): Promise<void> {
  await api.post(`/groups/${groupId}/messages/delete`, { ids });
}
