export type OutgoingState = 'pending' | 'failed';

export interface OutgoingPayload {
  chatId: string;
  text: string;
  filePath?: string;
  fileWidth?: number;
  fileHeight?: number;
  replyToId?: number;
  forwardedFromName?: string;
  forwardedFromChat?: string;
  poll?: unknown;
  /**
   * Стикер — самостоятельный тип сообщения, отправляется сразу тапом в
   * пикере, а не через прикрепление к полю ввода. Заведён на том же уровне,
   * что filePath: очередь отправки (pending/failed/retry) уже построена для
   * изображений и работает для стикера без единой лишней строки.
   */
  stickerId?: number;
  /**
   * Файл (документ, архив). Как и картинка, грузится отдельным
   * REST-запросом до отправки, а сюда попадает уже готовый путь.
   */
  documentPath?: string;
  documentName?: string;
  documentSize?: number;
  documentMime?: string;
  attachment?: {
    name: string;
    type: string;
    size: number;
  };
}

export interface OutgoingMessage {
  clientMessageId: string;
  temporaryId: number;
  userId: number;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  state: OutgoingState;
  lastError?: string;
  payload: OutgoingPayload;
}

const STORAGE_PREFIX = 'miras-outgoing-v1:';
let temporarySequence = 0;

function storageKey(userId: number): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function validItem(value: unknown, userId: number): value is OutgoingMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OutgoingMessage>;
  return item.userId === userId
    && typeof item.clientMessageId === 'string'
    && typeof item.temporaryId === 'number'
    && typeof item.createdAt === 'string'
    && !!item.payload
    && typeof item.payload.chatId === 'string'
    && typeof item.payload.text === 'string';
}

export function loadOutgoingQueue(userId: number): OutgoingMessage[] {
  if (!userId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(userId)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => validItem(item, userId)) : [];
  } catch {
    return [];
  }
}

export function saveOutgoingQueue(userId: number, queue: OutgoingMessage[]): void {
  if (!userId) return;
  localStorage.setItem(storageKey(userId), JSON.stringify(queue));
}

export function createOutgoingMessage(userId: number, payload: OutgoingPayload): OutgoingMessage {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  temporarySequence = (temporarySequence + 1) % 1000;
  return {
    clientMessageId: `msg_${userId}_${randomPart}`,
    temporaryId: -(Date.now() * 1000 + temporarySequence),
    userId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
    state: 'pending',
    payload,
  };
}

export function retryDelayMs(attempts: number): number {
  // Быстрые первые повторы, затем не чаще раза в 30 секунд. Небольшой jitter
  // не даёт всем клиентам после восстановления сервера ударить одновременно.
  const base = Math.min(30_000, 1_000 * (2 ** Math.min(Math.max(attempts - 1, 0), 5)));
  return base + Math.floor(Math.random() * Math.min(1_000, base / 4));
}
