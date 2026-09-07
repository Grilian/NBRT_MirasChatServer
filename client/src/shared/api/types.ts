// Типы того, что отдаёт сервер.
//
// До 07.09.2026 их не было вовсе: из ста девяти вызовов API типизировано было
// пять, остальные возвращали `any`. Одна и та же `Message` при этом
// объявлялась дважды — в `Chat.tsx` и в `ChatWindow.tsx`, и версии успели
// разойтись: у одной были `read_by_me` и `force_notification`, у другой
// `read_at`. Тип у контракта должен быть один.
//
// Форма полей повторяет колонки базы (`snake_case`) намеренно: это ровно то,
// что приходит по сети, и переименование на границе означало бы ещё один слой,
// который придётся держать в согласии со схемой.

import type { WritePolicy } from '@/shared/lib/writePolicy';
import type { Poll } from './poll';
import type { ThreadSummary } from './thread';

/**
 * Реакция принадлежит человеку, а не сообщению: под сообщением их сколько
 * угодно, но у каждого — ровно одна. Приходит вместе с человеком, потому что
 * рисуется аватаром, а не счётчиком.
 */
export interface MessageReaction {
  emoji: string;
  created_at: number;
  user: {
    id: number;
    username: string;
    display_name: string | null;
    avatar_path: string | null;
  };
}

/** Состояние доставки. `sending` и `failed` — только у локальной очереди. */
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: number;
  chat_id?: string;
  text: string;

  /** Картинка: пережимается в webp и рисуется прямо в ленте. */
  file_path?: string | null;
  file_width?: number | null;
  file_height?: number | null;
  /** Локальный URL ещё не отправленного вложения — только у очереди отправки. */
  local_file_url?: string | null;

  /** Ссылка на элемент пака — картинка резолвится через каталог стикеров. */
  sticker_id?: number | null;
  /**
   * Копия эмодзи стикера НА МОМЕНТ ОТПРАВКИ. В отличие от смайлика, стикер не
   * может деградировать до текста при удалении картинки в панели — этот глиф и
   * есть запасной вариант отрисовки.
   */
  sticker_fallback?: string | null;

  /** Файл: путь, показанное человеку имя, размер и тип. */
  document_path?: string | null;
  document_name?: string | null;
  document_size?: number | null;
  document_mime?: string | null;
  /** Вложение убрано в архив: файл с диска уехал в zip, сообщение осталось. */
  attachment_archived_at?: number | null;

  sender_id: number;
  username: string;
  display_name?: string | null;
  avatar_path?: string | null;
  created_at: string;

  status?: MessageStatus;
  client_message_id?: string | null;
  delivery_error?: string;
  edited_at?: string | null;
  deleted?: boolean | number;

  /** Когда прочитали — только в личной переписке (см. readReceipts на сервере). */
  read_at?: number | null;
  /** Личная отметка о прочтении — единственный достоверный признак в общих чатах. */
  read_by_me?: number | boolean;
  /** Сколько человек прочитало — приходит только в каналах-объявлениях. */
  read_count?: number;

  reply_to_id?: number | null;
  reply_to_text?: string | null;
  reply_to_file?: string | null;
  reply_to_sticker_fallback?: string | null;
  reply_to_document_name?: string | null;
  reply_to_author?: string | null;
  reply_to_deleted?: number | boolean | null;

  forwarded_from_name?: string | null;
  forwarded_from_chat?: string | null;

  reactions?: MessageReaction[];
  poll?: Poll;
  thread?: ThreadSummary;

  /** Подтверждённый сервером сигнал администратора в обход локального глушения. */
  force_notification?: boolean;
}

/** Страница истории. Курсорная и постраничная выдачи дают одну форму. */
export interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
  /** Запрошенное сообщение слишком далеко: окно вышло бы больше предела. */
  truncated?: boolean;
}

/** Превью последнего сообщения для строки списка чатов. */
export interface LastMessage {
  chat_id: string;
  text: string;
  file_path?: string | null;
  file_width?: number | null;
  file_height?: number | null;
  document_name?: string | null;
  sticker_fallback?: string | null;
  sender_id?: number;
  sender_name?: string | null;
  status?: MessageStatus;
  created_at: string;
}

export interface User {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  bio: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  birth_date: string | null;
  group_id: number | null;
  group_name: string | null;
  status_preset?: string | null;
  status_custom?: string | null;
  status_expires_at?: number | null;
}

/** chatId -> сколько непрочитанных. */
export type UnreadCounts = Record<string, number>;

/** Группа или канал-объявление, как их видит участник. */
export interface ChatGroupSummary {
  id: number;
  chat_id: string;
  name: string;
  created_by: number;
  created_at: number;
  member_count: number;
  role: 'owner' | 'member';
  announcements_only: boolean;
  /** Фото профиля группы — ставит владелец. */
  avatar_path?: string | null;
  write_policy: WritePolicy;
  write_user_ids: number[];
  write_department_ids: number[];
  /** Считает сервер под конкретного зрителя — клиент эту логику не повторяет. */
  can_post?: boolean;
}
