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
