import React, { useEffect, useRef, useState } from 'react';

interface Message {
  id: number;
  text: string;
  sender_id: number;
  username: string;
  created_at: string;
  status?: 'sent' | 'delivered' | 'read';
  edited_at?: string | null;
  deleted?: boolean | number;
}

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  currentUserId: number;
  typingUser?: string;
  onScrollTop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onEditMessage: (id: number, text: string) => void;
  onDeleteMessage: (id: number) => void;
}

const LONG_PRESS_MS = 450;

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
  chatId, messages, currentUserId, typingUser, onScrollTop, hasMore, loadingMore,
  onEditMessage, onDeleteMessage
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [shouldScrollToBottom, setShouldScrollToBottom] = useState(true);
  const prevMessagesLengthRef = useRef(0);

  const [menuFor, setMenuFor] = useState<{ id: number; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    setMenuFor(null);
    setEditingId(null);
  }, [chatId]);

  // Закрытие контекстного меню по клику снаружи
  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
    };
  }, [menuFor]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setShouldScrollToBottom(isAtBottom);

    if (scrollTop < 100 && onScrollTop && hasMore && !loadingMore) {
      onScrollTop();
    }
  };

  const openMenuAt = (msg: Message, x: number, y: number) => {
    if (msg.sender_id !== currentUserId || msg.deleted) return;
    setMenuFor({ id: msg.id, x, y });
  };

  const handleContextMenu = (e: React.MouseEvent, msg: Message) => {
    e.preventDefault();
    openMenuAt(msg, e.clientX, e.clientY);
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleTouchStart = (e: React.TouchEvent, msg: Message) => {
    const touch = e.touches[0];
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      openMenuAt(msg, touch.clientX, touch.clientY);
    }, LONG_PRESS_MS);
  };

  const startEdit = (msg: Message) => {
    setEditingId(msg.id);
    setEditText(msg.text);
    setMenuFor(null);
  };

  const commitEdit = () => {
    if (editingId === null) return;
    const trimmed = editText.trim();
    if (trimmed) onEditMessage(editingId, trimmed);
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const confirmDelete = (id: number) => {
    setMenuFor(null);
    if (window.confirm('Удалить сообщение без возможности восстановления?')) {
      onDeleteMessage(id);
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
        const isDeleted = !!msg.deleted;
        const isEditing = editingId === msg.id;

        return (
          <div
            key={msg.id}
            className={'msg ' + (mine ? 'mine' : 'theirs')}
            onContextMenu={mine ? (e) => handleContextMenu(e, msg) : undefined}
            onTouchStart={mine ? (e) => handleTouchStart(e, msg) : undefined}
            onTouchEnd={mine ? clearLongPress : undefined}
            onTouchMove={mine ? clearLongPress : undefined}
          >
            {!mine && <div className="who">{msg.username}</div>}
            {isEditing ? (
              <div className="bubble bubble-editing">
                <input
                  autoFocus
                  className="bubble-edit-input"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                  }}
                  onBlur={commitEdit}
                />
              </div>
            ) : (
              <div className={'bubble' + (isDeleted ? ' bubble-deleted' : '')}>
                {isDeleted ? 'Сообщение удалено' : msg.text}
              </div>
            )}
            <div className="meta-row">
              {msg.edited_at && !isDeleted && <span className="edited-label">изменено</span>}
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

      {menuFor && (
        <div
          ref={menuRef}
          className="msg-context-menu"
          style={{ left: menuFor.x, top: menuFor.y }}
        >
          <button type="button" onClick={() => {
            const msg = messages.find(m => m.id === menuFor.id);
            if (msg) startEdit(msg);
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            Редактировать
          </button>
          <button type="button" className="danger" onClick={() => confirmDelete(menuFor.id)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            Удалить
          </button>
        </div>
      )}
    </div>
  );
};

export default ChatWindow;
