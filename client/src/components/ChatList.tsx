import React, { useState } from 'react';
import { colorForName, initialsForName } from '../utils/avatar';

export type ChatSection = 'general' | 'admin' | 'staff';

interface Chat {
  id: string;
  name: string;
  section: ChatSection;
  online?: boolean;
  userId?: number;
  deletable?: boolean;
}

interface LastMessage {
  text: string;
  created_at: string;
}

interface Comment {
  username: string;
  comment: string;
}

interface ChatListProps {
  username: string;
  chats: Chat[];
  activeChat: string | null;
  onSelectChat: (chatId: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  lastMessages: Record<string, LastMessage>;
  unreadCounts: Record<string, number>;
  favorites: string[];
  onToggleFavorite: (chatId: string) => void;
  onUpdateComment: (userId: number, comment: string) => void;
  comments: Record<number, Comment>;
  isAdmin?: boolean;
  onDeleteUser?: (userId: number) => void;
  onMarkAllRead: () => void;
}

const SECTION_LABELS: Record<ChatSection, string | null> = {
  general: null,
  admin: 'Администрация',
  staff: 'Сотрудники',
};

function renderAvatar(chat: Chat) {
  if (chat.section === 'general') {
    return (
      <div className="avatar avatar-general">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    );
  }
  return (
    <div className="avatar" style={{ background: colorForName(chat.name) }}>
      {initialsForName(chat.name)}
      {chat.online !== undefined && <span className={'dot' + (chat.online ? '' : ' offline')} />}
    </div>
  );
}

const ChatList: React.FC<ChatListProps> = ({
  username, chats, activeChat, onSelectChat, searchQuery, onSearchChange,
  lastMessages, unreadCounts, favorites, onToggleFavorite, onUpdateComment, comments,
  isAdmin, onDeleteUser, onMarkAllRead
}) => {
  const [editingComment, setEditingComment] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');

  const handleCommentSubmit = (userId: number) => {
    onUpdateComment(userId, commentText);
    setEditingComment(null);
    setCommentText('');
  };

  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
  const filtered = chats.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()));

  let lastSection: ChatSection | null = null;

  return (
    <aside className="roster">
      <div className="roster-head">
        {/* Заготовка под кнопку аккаунта (аватар + имя) — пока некликабельная, логика будет позже */}
        <div className="roster-account">
          <div className="avatar avatar-sm" style={{ background: colorForName(username) }}>
            {initialsForName(username)}
          </div>
          <div className="roster-account-name">{username}</div>
          {totalUnread > 0 && (
            <>
              <span className="row-unread" style={{ marginLeft: 'auto' }}>{totalUnread}</span>
              <button
                type="button"
                className="mark-all-read-btn"
                title="Прочитать всё"
                onClick={onMarkAllRead}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M20 6 9 17l-5-5" /></svg>
              </button>
            </>
          )}
        </div>
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input
            type="text"
            placeholder="Поиск"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      <div className="roster-list">
        {filtered.length === 0 && <div className="roster-empty">Ничего не найдено</div>}
        {filtered.map((chat) => {
          const showLabel = chat.section !== lastSection && SECTION_LABELS[chat.section];
          lastSection = chat.section;
          const last = lastMessages[chat.id];
          const unreadCount = unreadCounts[chat.id] || 0;
          const isFavorite = favorites.includes(chat.id);

          return (
            <React.Fragment key={chat.id}>
              {showLabel && <div className="roster-section">{SECTION_LABELS[chat.section]}</div>}
              <div
                tabIndex={0}
                role="button"
                aria-current={activeChat === chat.id}
                className={'row' + (activeChat === chat.id ? ' is-active' : '')}
                onClick={() => onSelectChat(chat.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectChat(chat.id); } }}
              >
                {renderAvatar(chat)}
                <div className="row-body">
                  <div className="row-top">
                    <div className="row-name">
                      <span>{chat.name}</span>
                      {chat.section === 'admin' && <span className="badge-admin">МИРАС</span>}
                    </div>
                    {last && (
                      <div className="row-time">
                        {new Date(last.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                  </div>
                  <div className="row-bottom">
                    <div className="row-preview">{last ? last.text : ''}</div>
                    <div className="row-actions">
                      {unreadCount > 0 && <span className="row-unread">{unreadCount}</span>}
                      {chat.userId && (
                        <button
                          type="button"
                          className="icon-btn-ghost"
                          title="Добавить комментарий"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingComment(chat.userId!);
                            setCommentText(comments[chat.userId!]?.comment || '');
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                        </button>
                      )}
                      {isAdmin && chat.deletable && chat.userId && onDeleteUser && (
                        <button
                          type="button"
                          className="icon-btn-ghost danger"
                          title="Удалить аккаунт сотрудника"
                          onClick={(e) => { e.stopPropagation(); onDeleteUser(chat.userId!); }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                        </button>
                      )}
                      <button
                        type="button"
                        className={'icon-btn-ghost star' + (isFavorite ? ' is-fav' : '')}
                        title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                        onClick={(e) => { e.stopPropagation(); onToggleFavorite(chat.id); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
                          <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                {editingComment === chat.userId && (
                  <div className="comment-popover" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Комментарий..."
                      autoFocus
                    />
                    <div className="comment-popover-actions">
                      <button type="button" className="save" onClick={() => handleCommentSubmit(chat.userId!)}>Сохранить</button>
                      <button type="button" className="cancel" onClick={() => setEditingComment(null)}>Отмена</button>
                    </div>
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </aside>
  );
};

export default ChatList;
