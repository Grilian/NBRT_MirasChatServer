import React, { useState } from 'react';

interface Chat {
  id: string;
  name: string;
  online?: boolean;
  userId?: number;
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
}

const ChatList: React.FC<ChatListProps> = ({
  chats, activeChat, onSelectChat, searchQuery, onSearchChange,
  lastMessages, unreadCounts, favorites, onToggleFavorite, onUpdateComment, comments
}) => {
  const [editingComment, setEditingComment] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');

  const handleCommentSubmit = (userId: number) => {
    onUpdateComment(userId, commentText);
    setEditingComment(null);
    setCommentText('');
  };

  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>MirasChat</h2>
        {totalUnread > 0 && (
          <span style={styles.totalUnread}>{totalUnread}</span>
        )}
      </div>
      <div style={styles.searchBox}>
        <input
          type="text"
          placeholder="🔍 Поиск..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          style={styles.searchInput}
        />
      </div>
      <div style={styles.list}>
        {chats.map((chat) => {
          const last = lastMessages[chat.id];
          const unreadCount = unreadCounts[chat.id] || 0;
          const isFavorite = favorites.includes(chat.id);
          
          return (
            <div
              key={chat.id}
              onClick={() => onSelectChat(chat.id)}
              style={{
                ...styles.chatItem,
                ...(activeChat === chat.id ? styles.chatItemActive : {})
              }}
            >
              <div style={styles.chatTop}>
                <div style={styles.chatNameRow}>
                  {chat.online !== undefined && (
                    <span style={chat.online ? styles.online : styles.offline} />
                  )}
                  {isFavorite && <span style={styles.star}>★</span>}
                  <span style={styles.chatName}>{chat.name}</span>
                </div>
                <div style={styles.actions}>
                  {last && (
                    <span style={styles.time}>
                      {new Date(last.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {chat.userId && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingComment(chat.userId!);
                        setCommentText(comments[chat.userId!]?.comment || '');
                      }}
                      style={styles.commentBtn}
                      title="Добавить комментарий"
                    >
                      ✎
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(chat.id);
                    }}
                    style={{
                      ...styles.favoriteBtn,
                      color: isFavorite ? '#c9a227' : '#6b7b6e'
                    }}
                  >
                    {isFavorite ? '★' : '☆'}
                  </button>
                </div>
              </div>
              <div style={styles.chatBottom}>
                {last && (
                  <div style={styles.lastMessage}>{last.text}</div>
                )}
                {unreadCount > 0 && (
                  <span style={styles.unreadBadge}>{unreadCount}</span>
                )}
              </div>
              
              {editingComment === chat.userId && (
                <div style={styles.commentModal} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Комментарий..."
                    style={styles.commentInput}
                    autoFocus
                  />
                  <div style={styles.commentButtons}>
                    <button 
                      onClick={() => handleCommentSubmit(chat.userId!)}
                      style={styles.commentSaveBtn}
                    >
                      ✓
                    </button>
                    <button 
                      onClick={() => setEditingComment(null)}
                      style={styles.commentCancelBtn}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    width: '320px',
    background: '#1a472a',
    borderRight: '2px solid #c9a227',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #2d5a3d',
  },
  title: {
    margin: 0,
    color: '#c9a227',
    fontSize: '22px',
    fontWeight: 'bold',
  },
  totalUnread: {
    background: '#c9a227',
    color: '#ffffff',
    borderRadius: '16px',
    padding: '4px 12px',
    fontSize: '14px',
    fontWeight: 'bold',
    minWidth: '28px',
    textAlign: 'center',
  },
  searchBox: {
    padding: '12px 16px',
    borderBottom: '1px solid #2d5a3d',
  },
  searchInput: {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid #4a7c59',
    borderRadius: '8px',
    background: '#0D3310',
    color: '#ffffff',
    fontSize: '14px',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
  },
  chatItem: {
    padding: '14px 20px',
    borderBottom: '1px solid #2d5a3d',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  chatItemActive: {
    background: '#2d5a3d',
    borderLeft: '4px solid #c9a227',
  },
  chatTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '4px',
  },
  chatNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  online: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#4caf50',
    display: 'inline-block',
  },
  offline: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#6b7b6e',
    display: 'inline-block',
  },
  chatName: {
    fontWeight: 'bold',
    color: '#ffffff',
    fontSize: '15px',
  },
  time: {
    fontSize: '12px',
    color: '#8fae98',
  },
  chatBottom: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMessage: {
    flex: 1,
    fontSize: '13px',
    color: '#b8d4c4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingLeft: '18px',
  },
  unreadBadge: {
    background: '#c9a227',
    color: '#ffffff',
    borderRadius: '12px',
    padding: '2px 8px',
    fontSize: '12px',
    fontWeight: 'bold',
    minWidth: '20px',
    textAlign: 'center',
  },
  star: {
    color: '#c9a227',
    fontSize: '14px',
    marginRight: '4px',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  commentBtn: {
    background: 'transparent',
    border: 'none',
    color: '#6b7b6e',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '4px',
  },
  favoriteBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '4px',
  },
  commentModal: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: '#1a472a',
    border: '2px solid #c9a227',
    borderRadius: '8px',
    padding: '16px',
    zIndex: 1000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  },
  commentInput: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #4a7c59',
    borderRadius: '6px',
    background: '#0D3310',
    color: '#ffffff',
    fontSize: '14px',
    marginBottom: '8px',
  },
  commentButtons: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  },
  commentSaveBtn: {
    background: '#c9a227',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    padding: '4px 12px',
    cursor: 'pointer',
  },
  commentCancelBtn: {
    background: 'transparent',
    color: '#6b7b6e',
    border: '1px solid #6b7b6e',
    borderRadius: '4px',
    padding: '4px 12px',
    cursor: 'pointer',
  },
};

export default ChatList;