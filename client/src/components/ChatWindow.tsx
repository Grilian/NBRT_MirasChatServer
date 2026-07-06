import React, { useEffect, useRef, useState } from 'react';

interface Message {
  id: number;
  text: string;
  sender_id: number;
  username: string;
  created_at: string;
  status?: 'sent' | 'delivered' | 'read';
}

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  currentUserId: number;
  typingUser?: string;
  onScrollTop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  chatName?: string;
}

const ChatWindow: React.FC<ChatWindowProps> = ({ 
  chatId, messages, currentUserId, typingUser, onScrollTop, hasMore, loadingMore,
  isFavorite, onToggleFavorite, chatName
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [shouldScrollToBottom, setShouldScrollToBottom] = useState(true);
  const prevMessagesLengthRef = useRef(0);

  useEffect(() => {
    if (messages.length === 0) return;
    
    if (messages.length > prevMessagesLengthRef.current) {
      if (shouldScrollToBottom) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    }
    
    prevMessagesLengthRef.current = messages.length;
  }, [messages, shouldScrollToBottom]);

  useEffect(() => {
    setShouldScrollToBottom(true);
    prevMessagesLengthRef.current = 0;
  }, [chatId]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setShouldScrollToBottom(isAtBottom);
    
    if (scrollTop < 100 && onScrollTop && hasMore && !loadingMore) {
      onScrollTop();
    }
  };

  const renderStatus = (message: Message) => {
    if (message.sender_id !== currentUserId) return null;
    
    const status = message.status || 'sent';
    let icon = '✓';
    let color = '#888';
    
    if (status === 'delivered') {
      icon = '✓✓';
      color = '#888';
    } else if (status === 'read') {
      icon = '✓✓';
      color = '#4a9eff';
    }
    
    return <span style={{ ...styles.status, color }}>{icon}</span>;
  };

  if (!chatId) {
    return (
      <div style={styles.empty}>
        <h2 style={{ color: '#6b7b6e' }}>Выберите чат</h2>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.chatHeader}>
        <div style={styles.chatTitle}>
          {isFavorite && <span style={styles.star}>★</span>}
          {chatName || chatId}
        </div>
        {onToggleFavorite && (
          <button 
            onClick={onToggleFavorite}
            style={{
              ...styles.favoriteBtn,
              color: isFavorite ? '#c9a227' : '#6b7b6e'
            }}
          >
            {isFavorite ? '★' : '☆'}
          </button>
        )}
      </div>
      <div 
        ref={messagesContainerRef}
        style={styles.messages}
        onScroll={handleScroll}
      >
        {loadingMore && (
          <div style={styles.loading}>Загрузка...</div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...styles.message,
              ...(msg.sender_id === currentUserId ? styles.myMessage : styles.otherMessage)
            }}
          >
            <div style={styles.username}>{msg.username}</div>
            <div style={styles.text}>{msg.text}</div>
            <div style={styles.footer}>
              <span style={styles.time}>
                {new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </span>
              {renderStatus(msg)}
            </div>
          </div>
        ))}
        {typingUser && (
          <div style={styles.typing}>{typingUser} печатает...</div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#f5f5dc',
    overflow: 'hidden',
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5dc',
  },
  messages: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  loading: {
    textAlign: 'center',
    color: '#6b7b6e',
    padding: '12px',
    fontSize: '14px',
  },
  message: {
    maxWidth: '70%',
    padding: '12px 16px',
    borderRadius: '12px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
  },
  myMessage: {
    alignSelf: 'flex-end',
    background: '#c9a227',
    color: '#ffffff',
  },
  otherMessage: {
    alignSelf: 'flex-start',
    background: '#ffffff',
    color: '#2c3e2d',
    border: '1px solid #e0d5b8',
  },
  username: {
    fontSize: '11px',
    fontWeight: 'bold',
    marginBottom: '4px',
    opacity: 0.8,
  },
  text: {
    fontSize: '15px',
    lineHeight: 1.5,
    wordWrap: 'break-word',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '4px',
    marginTop: '4px',
  },
  time: {
    fontSize: '11px',
    opacity: 0.7,
  },
  status: {
    fontSize: '12px',
    fontWeight: 'bold',
  },
  typing: {
    alignSelf: 'flex-start',
    fontSize: '13px',
    color: '#6b7b6e',
    fontStyle: 'italic',
    padding: '8px 12px',
  },
  chatHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    background: '#1a472a',
    borderBottom: '2px solid #c9a227',
  },
  chatTitle: {
    color: '#c9a227',
    fontSize: '18px',
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  star: {
    color: '#c9a227',
    fontSize: '20px',
  },
  favoriteBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: '24px',
    cursor: 'pointer',
    padding: '4px 8px',
    transition: 'color 0.3s',
  },
};

export default ChatWindow;