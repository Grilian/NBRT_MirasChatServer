export interface ThreadAuthor {
  id: number;
  username: string;
  display_name?: string | null;
  avatar_path?: string | null;
}

export interface ThreadSummary {
  reply_count: number;
  unread_count: number;
  last_reply_at: string | null;
  recent_authors: ThreadAuthor[];
}

export interface ThreadInboxMessage extends ThreadAuthor {
  id: number;
  text: string;
  file_path?: string | null;
  created_at: string;
  sender_id: number;
}

export interface ThreadInboxItem {
  root_id: number;
  chat_id: string;
  chat: { name: string; kind: 'general' | 'group' | 'personal' | 'self'; avatar_path?: string | null };
  root: ThreadInboxMessage;
  last_reply: ThreadInboxMessage;
  summary: ThreadSummary;
}
