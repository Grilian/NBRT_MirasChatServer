import React from 'react';
import Avatar from './Avatar';
import { ThreadInboxItem } from '../types/thread';
import { CustomEmojiMap, renderTextWithEmoji } from '../utils/customEmoji';
import { formatChatListTime } from '../utils/time';

interface ThreadInboxProps {
  items: ThreadInboxItem[];
  loading: boolean;
  activeRootId?: number | null;
  customEmoji?: CustomEmojiMap;
  onBack: () => void;
  onOpen: (rootId: number) => void;
}

const authorName = (item: ThreadInboxItem['root']) => item.display_name || item.username;
const preview = (text: string, hasFile: boolean) => text || (hasFile ? '📷 Изображение' : 'Сообщение');

const ThreadInbox: React.FC<ThreadInboxProps> = ({
  items, loading, activeRootId, customEmoji = {}, onBack, onOpen,
}) => (
  <main className="conversation thread-inbox">
    <div className="conv-head thread-inbox-head">
      <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Назад к списку чатов">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <div className="conv-title">
        <div className="name">Ветки</div>
        <div className="status">Все обсуждения, в которых вы участвовали</div>
      </div>
    </div>
    <div className="thread-inbox-list">
      {loading && items.length === 0 && <div className="thread-inbox-empty">Загружаем ветки…</div>}
      {!loading && items.length === 0 && (
        <div className="thread-inbox-empty">
          <span className="thread-inbox-empty-icon">#</span>
          <strong>У вас пока нет веток</strong>
          <span>Ответьте на сообщение или создайте ветку — обсуждение появится здесь.</span>
        </div>
      )}
      {items.map((item) => (
        <button
          type="button"
          key={item.root_id}
          className={'thread-inbox-row' + (activeRootId === item.root_id ? ' is-active' : '')}
          onClick={() => onOpen(item.root_id)}
        >
          <Avatar name={authorName(item.root)} avatarPath={item.root.avatar_path} />
          <span className="thread-inbox-body">
            <span className="thread-inbox-meta">
              <strong>{item.chat.name}</strong>
              <time>{formatChatListTime(item.last_reply.created_at)}</time>
            </span>
            <span className="thread-inbox-root">
              {renderTextWithEmoji(preview(item.root.text, !!item.root.file_path), customEmoji, `tr${item.root_id}`)}
            </span>
            <span className="thread-inbox-last">
              <b>{authorName(item.last_reply)}:</b>{' '}
              {renderTextWithEmoji(preview(item.last_reply.text, !!item.last_reply.file_path), customEmoji, `tl${item.root_id}`)}
            </span>
          </span>
          <span className="thread-inbox-stats">
            {item.summary.unread_count > 0 && <span className="row-unread">{item.summary.unread_count}</span>}
            <span>{item.summary.reply_count}</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>
          </span>
        </button>
      ))}
    </div>
  </main>
);

export default ThreadInbox;
