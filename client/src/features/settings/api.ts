// Свой профиль и права.

import api from '@/shared/api/client';

/** Своя учётная запись целиком — то, чего нет в localStorage. */
export async function fetchMe(): Promise<Record<string, unknown>> {
  const { data } = await api.get('/users/me');
  return data;
}

/** Удаление собственного аккаунта. Необратимо. */
export async function deleteOwnAccount(): Promise<void> {
  await api.delete('/users/me');
}

/**
 * Группы, которыми человек управляет как орг-администратор.
 *
 * Отдельная ручка от `/groups`: та отвечает «в каких группах я состою», эта —
 * «какие я вправе модерировать».
 */
export async function fetchModeratedGroups(): Promise<{ id: number; name: string }[]> {
  const { data } = await api.get('/moderation/groups');
  return data;
}
