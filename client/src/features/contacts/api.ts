// Люди: справочник, контакты, заметки о человеке.
//
// Важное правило, которое стоит держать в голове при чтении этого файла:
// `/users` и `/contacts` — РАЗНЫЕ вещи. Первое отвечает на вопрос «кому вообще
// можно написать» и разделено по типу аккаунта без исключений («Интернет»
// видит только «Интернет»). Второе — те, кого уже добавили, и под разделение
// оно НЕ подведено: добавленные контакты остаются видны обеим сторонам.

import api from '@/shared/api/client';
import type { User } from '@/shared/api/types';

/** Справочник: кому можно написать. Разделён по типу аккаунта на сервере. */
export async function fetchDirectory(): Promise<User[]> {
  const { data } = await api.get('/users');
  return data;
}

/** Люди, уже добавленные в список чатов. */
export async function fetchContacts(): Promise<User[]> {
  const { data } = await api.get('/contacts');
  return data;
}

export async function addContact(userId: number): Promise<void> {
  await api.post(`/contacts/${userId}`);
}

export async function removeContact(userId: number): Promise<void> {
  await api.delete(`/contacts/${userId}`);
}

export interface UserComment {
  username: string;
  display_name: string | null;
  comment: string;
}

/** Личные заметки о людях — видны только автору. */
export async function fetchComments(): Promise<Record<number, UserComment>> {
  const { data } = await api.get('/comments');
  return data;
}

export async function saveComment(targetUserId: number, comment: string): Promise<void> {
  await api.post('/comments', { target_user_id: targetUserId, comment });
}

export async function fetchDepartments(): Promise<{ id: number; name: string }[]> {
  const { data } = await api.get('/departments');
  return data;
}
