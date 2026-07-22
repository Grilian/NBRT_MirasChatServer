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
}

function TickIcon({ status }: { status: 'sent' | 'delivered' | 'read' }) {
  const doubleTick = status === 'delivered' || status === 'read';
  return (
    <span className={'ticks' + (status === 'read' ? ' read' : '')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
        {doubleTick ? (
          <><path d="m2 12 5 5L18 6" /><path d="m8 12 5 5L24 6" /></>
        ) : (
          <path d="m5 12 5 5L21 6" />
        )}
      </svg>
    </span>
  );
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  chatId, messages, currentUserId, typingUser, onScrollTop, hasMore, loadingMore
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

  if (!chatId) {
    return <div className="conv-empty">Выберите чат</div>;
  }

  return (
    <div
      ref={messagesContainerRef}
      className="conv-body"
      onScroll={handleScroll}
    >
      {loadingMore && <div className="load-more-hint">Загрузка...</div>}
      {messages.length === 0 && !loadingMore && <div className="load-more-hint">Сообщений пока нет</div>}
      {messages.length > 0 && <div className="date-sep">Сегодня</div>}
      {messages.map((msg) => {
        const mine = msg.sender_id === currentUserId;
        return (
          <div key={msg.id} className={'msg ' + (mine ? 'mine' : 'theirs')}>
            {!mine && <div className="who">{msg.username}</div>}
            <div className="bubble">{msg.text}</div>
            <div className="meta-row">
              <span>{new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
              {mine && <TickIcon status={msg.status || 'sent'} />}
            </div>
          </div>
        );
      })}
      {typingUser && (
        <div className="typing-row">
          <div className="bubble">
            <span className="dot" /><span className="dot" /><span className="dot" />
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatWindow;
