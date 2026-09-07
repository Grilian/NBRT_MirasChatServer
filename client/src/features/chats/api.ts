// Обращения к серверу за перепиской.
//
// Пути к ручкам собраны здесь, а не разбросаны строками по компонентам: до
// 07.09.2026 один только `Chat.tsx` держал сорок один такой литерал, и увидеть
// всю поверхность обмена было негде. Заодно у ответов появились типы —
// раньше из ста девяти вызовов типизировано было пять.

import api from '@/shared/api/client';
import type { HistoryPage, LastMessage, Message, UnreadCounts } from '@/shared/api/types';

/** Сколько сообщений тянем за раз. Совпадает с пределом на сервере. */
export const HISTORY_PAGE_SIZE = 50;

/** Последняя страница переписки — то, что видно при открытии чата. */
export async function fetchHistory(chatId: string): Promise<HistoryPage> {
  const { data } = await api.get(`/messages/${chatId}?limit=${HISTORY_PAGE_SIZE}&offset=0`);
  return normalizePage(data);
}

/** Страница выше уже загруженного — подгрузка при прокрутке вверх. */
export async function fetchHistoryBefore(chatId: string, beforeId: number): Promise<HistoryPage> {
  const { data } = await api.get(`/messages/${chatId}?limit=${HISTORY_PAGE_SIZE}&before=${beforeId}`);
  return normalizePage(data);
}

/**
 * Окно «от сообщения и до низа ленты» — переход к вложению из карточки чата.
 *
 * Листать до него постранично значило бы десяток запросов подряд. Окно
 * оставляет НИЗ ленты загруженным, поэтому обычная прокрутка и подгрузка вверх
 * продолжают работать. Слишком далёкое сообщение приходит с `truncated`.
 */
export async function fetchHistoryFrom(chatId: string, messageId: number): Promise<HistoryPage> {
  const { data } = await api.get(`/messages/${chatId}?from=${messageId}`);
  return normalizePage(data);
}

/**
 * Старая форма ответа — голый массив без `hasMore`. Приводим к одной форме
 * здесь, чтобы вызывающий код не разбирался в этом каждый раз заново.
 */
function normalizePage(data: HistoryPage | Message[]): HistoryPage {
  if (Array.isArray(data)) return { messages: data, hasMore: false };
  return { messages: data.messages || [], hasMore: !!data.hasMore, truncated: data.truncated };
}

/** Превью последних сообщений всех чатов — строки списка. */
export async function fetchLastMessages(): Promise<Record<string, LastMessage>> {
  const { data } = await api.get('/messages/meta/last');
  return data;
}

/** Порядок недавно открытых чатов — лента аватаров над списком. */
export async function fetchRecentChats(): Promise<string[]> {
  const { data } = await api.get('/messages/meta/recent');
  return data;
}

export async function markChatOpened(chatId: string): Promise<void> {
  await api.post(`/messages/meta/recent/${encodeURIComponent(chatId)}`);
}

export async function fetchUnread(): Promise<UnreadCounts> {
  const { data } = await api.get('/unread');
  return data;
}

/**
 * Очистить переписку. Только личный чат и «Избранное»: в группе и общем чате
 * это чужая переписка для десятков человек. Проверка есть и на сервере.
 *
 * «Очистка» — то же мягкое удаление: строки остаются в базе целиком, наружу
 * просто не отдаются.
 */
export async function clearChat(chatId: string): Promise<void> {
  await api.post(`/messages/${encodeURIComponent(chatId)}/clear`);
}

export async function markThreadRead(rootId: number): Promise<void> {
  await api.post(`/messages/threads/${rootId}/read`);
}

export interface UploadedImage {
  file_path: string;
  file_width: number;
  file_height: number;
}

export async function uploadImage(form: FormData): Promise<UploadedImage> {
  const { data } = await api.post('/messages/upload-image', form);
  return data;
}

export interface UploadedFile {
  file_path: string;
  /** Имя, под которым файл отправляли: на диске оно обеззаражено и со случайной частью. */
  name: string;
  size: number;
  mime: string;
}

export async function uploadFile(form: FormData): Promise<UploadedFile> {
  const { data } = await api.post('/messages/upload-file', form);
  return data;
}

/** Убрать вложение: файл уезжает в zip, само сообщение остаётся. */
export async function archiveAttachment(messageId: number): Promise<void> {
  await api.post(`/messages/${messageId}/attachment/archive`);
}

/** Глушение конкретного чата. */
export async function setChatMuted(chatId: string, muted: boolean): Promise<void> {
  await api.put(`/notification-settings/${encodeURIComponent(chatId)}`, { muted });
}

// ===== Закрепление чатов =====
//
// В интерфейсе это «Закрепить», но ручка и таблица на сервере по-прежнему
// `favorites`: переименована только видимая человеку часть. Причина в том, что
// рядом в списке есть личный чат «Избранное» (`self_<id>`), и звезда «в
// избранное» читалась как отправка туда.

/** Идентификаторы закреплённых чатов. */
export async function fetchPinnedChats(): Promise<string[]> {
  const { data } = await api.get('/favorites');
  return data;
}

export async function pinChat(chatId: string): Promise<void> {
  await api.post('/favorites', { chat_id: chatId });
}

export async function unpinChat(chatId: string): Promise<void> {
  await api.delete(`/favorites/${encodeURIComponent(chatId)}`);
}

/** Чаты, у которых человек выключил уведомления. */
export async function fetchMutedChats(): Promise<string[]> {
  const { data } = await api.get<{ muted_chat_ids: string[] }>('/notification-settings');
  return data.muted_chat_ids || [];
}
