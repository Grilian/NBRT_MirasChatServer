import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import ChatList from '../components/ChatList';
import ChatWindow from '../components/ChatWindow';
import MessageInput from '../components/MessageInput';
import api from '../api/client';

interface User { id: number; username: string; }
interface MirasAdmin { id: number; login: string; role: string; zone_id: number | null; }
interface Message {
  id: number;
  chat_id?: string;
  text: string;
  sender_id: number;
  username: string;
  created_at: string;
  status?: 'sent' | 'delivered' | 'read';
}
interface LastMessage {
  chat_id: string;
  text: string;
  created_at: string;
}
interface AllUser {
  id: number;
  username: string;
  source: 'local' | 'miras';
  mirasLogin?: string;
}

const GENERAL_CHAT_ID = 'general';

const Chat: React.FC = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [mirasAdmins, setMirasAdmins] = useState<MirasAdmin[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [activeChatName, setActiveChatName] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<number[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [lastMessages, setLastMessages] = useState<Record<string, LastMessage>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [favorites, setFavorites] = useState<string[]>([]);
  const [comments, setComments] = useState<Record<number, { username: string; comment: string }>>({});
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentUserId = Number(localStorage.getItem('userId'));
  const currentUsername = localStorage.getItem('username') || '';

  // Запрос разрешения на уведомления
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Подключение сокета
  useEffect(() => {
    const newSocket = io('http://192.168.24.2:3010', {
      path: '/MirasChatServer/socket.io',
    });
    setSocket(newSocket);

    newSocket.emit('user_online', currentUserId);

    // Загружаем локальных пользователей
    api.get('/users').then(({ data }) => setUsers(data)).catch(console.error);
    
    // Загружаем админов из МИРАС
    api.get('/miras-admins').then(({ data }) => setMirasAdmins(data)).catch(console.error);
    
    // Загружаем непрочитанные
    api.get('/unread').then(({ data }) => setUnreadCounts(data)).catch(console.error);
    
    // Загружаем избранное
    api.get('/favorites').then(({ data }) => setFavorites(data)).catch(console.error);
    
    // Загружаем комментарии
    api.get('/comments').then(({ data }) => setComments(data)).catch(console.error);

    newSocket.on('online_users', (userIds: number[]) => setOnlineUsers(userIds));

    newSocket.on('typing', (data: { chatId: string; userId: number; username: string }) => {
      if (data.userId !== currentUserId) {
        setTypingUsers(prev => ({ ...prev, [data.chatId]: data.username }));
      }
    });

    newSocket.on('stop_typing', (data: { chatId: string; userId: number }) => {
      setTypingUsers(prev => {
        const next = { ...prev };
        delete next[data.chatId];
        return next;
      });
    });

    newSocket.on('last_message', (data: LastMessage) => {
      setLastMessages(prev => ({ ...prev, [data.chat_id]: data }));
    });

    newSocket.on('message_status', (data: { id: number; status: 'sent' | 'delivered' | 'read' }) => {
      setMessages(prev => prev.map(m => m.id === data.id ? { ...m, status: data.status } : m));
    });

    newSocket.on('message_status_bulk', (data: { chatId: string; messageIds: number[]; status: 'read' }) => {
      setMessages(prev => prev.map(m => 
        data.messageIds.includes(m.id) ? { ...m, status: data.status } : m
      ));
    });

    return () => { newSocket.disconnect(); };
  }, [currentUserId]);

  // Единый обработчик новых сообщений
  useEffect(() => {
    if (!socket) return;

    const handler = (message: Message) => {
      // Добавляем сообщение в список если это активный чат
      if (message.chat_id === activeChat) {
        setMessages(prev => [...prev, message]);
      }

      // Если сообщение не от нас и чат не активен — увеличиваем счётчик
      if (message.sender_id !== currentUserId && message.chat_id !== activeChat && message.chat_id) {
        setUnreadCounts(prev => ({
          ...prev,
          [message.chat_id as string]: (prev[message.chat_id as string] || 0) + 1
        }));
      }

      // Показываем уведомление
      if (message.sender_id !== currentUserId) {
        const isChatActive = message.chat_id === activeChat;
        const isWindowFocused = document.hasFocus();
        
        if (!isChatActive || !isWindowFocused) {
          const chatName = message.chat_id === GENERAL_CHAT_ID 
            ? 'Общий чат' 
            : message.chat_id?.startsWith('miras_admin_')
              ? message.chat_id.replace('miras_admin_', '') + ' [МИРАС]'
              : allUsers.find(u => getChatId(u.id) === message.chat_id)?.username || 'Чат';
          
          showNotification(message, chatName);
        }
      }
    };

    socket.on('chat_message', handler);
    return () => { socket.off('chat_message', handler); };
  }, [socket, activeChat, currentUserId]);

  // Загрузка истории при смене чата
  useEffect(() => {
    if (activeChat) {
      setMessages([]);
      setHasMore(true);
      api.get(`/messages/${activeChat}?limit=50&offset=0`)
        .then(({ data }) => {
          if (data.messages) {
            setMessages(data.messages);
            setHasMore(data.hasMore);
          } else {
            setMessages(data);
            setHasMore(false);
          }
        })
        .catch(console.error);
      setUnreadCounts(prev => ({ ...prev, [activeChat]: 0 }));
    } else {
      setMessages([]);
    }
  }, [activeChat]);

  // Подгрузка старых сообщений
  const loadMoreMessages = async () => {
    if (!activeChat || loadingMore || !hasMore) return;
    
    setLoadingMore(true);
    try {
      const { data } = await api.get(`/messages/${activeChat}?limit=50&offset=${messages.length}`);
      if (data.messages) {
        setMessages(prev => [...data.messages, ...prev]);
        setHasMore(data.hasMore);
      }
    } catch (e) {
      console.error('Ошибка загрузки:', e);
    } finally {
      setLoadingMore(false);
    }
  };

  // Отметка прочитанных
  useEffect(() => {
    if (!socket || !activeChat || messages.length === 0) return;

    const unreadIds = messages
      .filter(m => m.sender_id !== currentUserId && m.status !== 'read')
      .map(m => m.id);

    if (unreadIds.length > 0) {
      socket.emit('message_read', { chatId: activeChat, messageIds: unreadIds });
    }
  }, [messages, activeChat, socket, currentUserId]);

  // Показ уведомления
  const showNotification = (message: Message, chatName: string) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(`MirasChat — ${chatName}`, {
        body: message.text,
        icon: '/logo192.png',
        tag: message.id.toString(),
      });

      notification.onshow = () => {
        if (socket) {
          socket.emit('message_delivered', message.id);
        }
      };
    }
  };

  const getChatId = (otherUserId: number) => {
    const ids = [currentUserId, otherUserId].sort((a, b) => a - b);
    return `chat_${ids[0]}_${ids[1]}`;
  };

  // Избранное
  const toggleFavorite = async (chatId: string) => {
    try {
      if (favorites.includes(chatId)) {
        await api.delete(`/favorites/${chatId}`);
        setFavorites(prev => prev.filter(id => id !== chatId));
      } else {
        await api.post('/favorites', { chat_id: chatId });
        setFavorites(prev => [...prev, chatId]);
      }
    } catch (e) {
      console.error('Ошибка:', e);
    }
  };

  // Комментарии
  const updateComment = async (targetUserId: number, comment: string) => {
    try {
      await api.post('/comments', { target_user_id: targetUserId, comment });
      const user = allUsers.find(u => u.id === targetUserId);
      if (user) {
        setComments(prev => ({
          ...prev,
          [targetUserId]: { username: user.username, comment }
        }));
      }
    } catch (e) {
      console.error('Ошибка:', e);
    }
  };

  // Объединение локальных пользователей и админов МИРАС
  const allUsers: AllUser[] = [
    ...users.map(u => ({ id: u.id, username: u.username, source: 'local' as const })),
    ...mirasAdmins.map(a => ({ 
      id: 10000 + a.id, 
      username: a.login, 
      source: 'miras' as const,
      mirasLogin: a.login 
    }))
  ];

  const handleSelectChat = (chatId: string) => {
    if (chatId === GENERAL_CHAT_ID) {
      setActiveChat(GENERAL_CHAT_ID);
      setActiveChatName('📢 Общий чат');
    } else if (chatId.startsWith('miras_admin_')) {
      const login = chatId.replace('miras_admin_', '');
      setActiveChat(chatId);
      setActiveChatName(`${login} [МИРАС]`);
    } else {
      const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === chatId);
      if (user) {
        setActiveChat(chatId);
        setActiveChatName(user.username);
      }
    }
  };

  const handleSendMessage = (text: string) => {
    if (socket && activeChat) {
      socket.emit('chat_message', {
        chatId: activeChat,
        senderId: currentUserId,
        senderUsername: currentUsername,
        text,
      });
      socket.emit('stop_typing', { chatId: activeChat, userId: currentUserId });
    }
  };

  const handleTyping = () => {
    if (socket && activeChat) {
      socket.emit('typing', {
        chatId: activeChat,
        userId: currentUserId,
        username: currentUsername,
      });

      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => {
        socket.emit('stop_typing', { chatId: activeChat, userId: currentUserId });
      }, 2000);
    }
  };

  const handleLogout = () => {
    localStorage.clear();
    window.location.reload();
  };

  // Формирование списка чатов
  const chats = [
    { id: GENERAL_CHAT_ID, name: '📢 Общий чат' },
    ...allUsers.map(u => {
      const commentData = comments[u.id];
      let displayName = u.username;
      
      if (commentData?.comment) {
        displayName = `${commentData.username} (${commentData.comment})`;
      }
      
      if (u.source === 'miras') {
        displayName = `${displayName} [МИРАС]`;
      }
      
      return {
        id: u.source === 'miras' ? `miras_admin_${u.mirasLogin}` : getChatId(u.id),
        name: displayName,
        online: u.source === 'local' ? onlineUsers.includes(u.id) : true,
        userId: u.id,
      };
    })
  ].filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      const aFav = favorites.includes(a.id) ? 1 : 0;
      const bFav = favorites.includes(b.id) ? 1 : 0;
      return bFav - aFav;
    });

  const typingText = activeChat ? typingUsers[activeChat] : undefined;

  return (
    <div style={styles.container}>
      <ChatList
        chats={chats}
        activeChat={activeChat}
        onSelectChat={handleSelectChat}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        lastMessages={lastMessages}
        unreadCounts={unreadCounts}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onUpdateComment={updateComment}
        comments={comments}
      />
      <div style={styles.rightPanel}>
        <div style={styles.header}>
          <h3 style={styles.headerTitle}>{activeChatName || 'Выберите чат'}</h3>
          <button onClick={handleLogout} style={styles.logoutBtn}>Выйти</button>
        </div>
        <ChatWindow
          chatId={activeChat}
          messages={messages}
          currentUserId={currentUserId}
          typingUser={typingText}
          onScrollTop={loadMoreMessages}
          hasMore={hasMore}
          loadingMore={loadingMore}
          isFavorite={activeChat ? favorites.includes(activeChat) : false}
          onToggleFavorite={() => activeChat && toggleFavorite(activeChat)}
          chatName={activeChatName}
        />
        <MessageInput
          onSend={handleSendMessage}
          onTyping={handleTyping}
          disabled={!activeChat}
        />
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: { display: 'flex', height: '100vh' },
  rightPanel: { flex: 1, display: 'flex', flexDirection: 'column' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    background: '#1a472a',
    borderBottom: '2px solid #c9a227',
  },
  headerTitle: {
    margin: 0,
    color: '#c9a227',
    fontSize: '18px',
  },
  logoutBtn: {
    padding: '8px 16px',
    background: 'transparent',
    color: '#c9a227',
    border: '1px solid #c9a227',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
  },
};

export default Chat;