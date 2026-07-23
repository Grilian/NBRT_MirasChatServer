import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { App as CapApp } from '@capacitor/app';
import ChatList, { ChatSection } from '../components/ChatList';
import ChatWindow from '../components/ChatWindow';
import MessageInput from '../components/MessageInput';
import SettingsPanel from '../components/SettingsPanel';
import ProfileEdit from '../components/ProfileEdit';
import api from '../api/client';
import { colorForName, initialsForName } from '../utils/avatar';
import {
  ensureMobileNotificationPermission,
  showMobileNotification,
  isNativeMobile,
  dismissMobileNotifications,
  dismissAllMobileNotifications,
  onMobileNotificationTap
} from '../utils/mobileNotify';

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
  edited_at?: string | null;
  deleted?: boolean | number;
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
const ADMIN_CHAT_PREFIX = 'miras_admin_';

// chat_id с админом — miras_admin_<login>_<myLocalUserId>, чтобы у каждого
// сотрудника был свой отдельный тред с этим админом (а не общий на всех).
function parseAdminChatId(chatId: string): { login: string; employeeId: string } | null {
  if (!chatId.startsWith(ADMIN_CHAT_PREFIX)) return null;

  const rest = chatId.slice(ADMIN_CHAT_PREFIX.length);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore === -1) return null;

  return {
    login: rest.slice(0, lastUnderscore),
    employeeId: rest.slice(lastUnderscore + 1)
  };
}

const Chat: React.FC = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [mirasAdmins, setMirasAdmins] = useState<MirasAdmin[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
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
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<'conversation' | 'settings' | 'profile'>('conversation');
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentUserId = Number(localStorage.getItem('userId'));
  const currentUsername = localStorage.getItem('username') || '';

  // Кто вошёл через логин МИРАС — тому доступно удаление чужих аккаунтов
  const isAdmin = localStorage.getItem('source') === 'miras';

  // Режим тишины — суперадмин может включить/выключить прямо во время сессии,
  // поэтому актуальное значение приходит и живьём по сокету (см. account_updated).
  const [muted, setMuted] = useState(localStorage.getItem('muted') === 'true');

  // Запрос разрешения на уведомления
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    ensureMobileNotificationPermission();
  }, []);

  // Красная точка в трее/оверлей на таскбаре (desktop) — пока есть непрочитанное
  useEffect(() => {
    const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
    window.electronAPI?.setUnreadBadge(totalUnread > 0);
  }, [unreadCounts]);

  // Аппаратная кнопка "назад" на Android — по умолчанию сразу закрывала бы
  // приложение (нет истории браузера). Идём по своему стеку экранов:
  // профиль -> настройки -> переписка -> список чатов, и только с самого
  // списка сворачиваем приложение, а не убиваем процесс.
  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('backButton', () => {
      if (view === 'profile') { setView('settings'); return; }
      if (view === 'settings') { setView('conversation'); return; }
      if (mobileView === 'chat') { setMobileView('list'); return; }
      CapApp.minimizeApp();
    });
    return () => { listenerPromise.then((h) => h.remove()); };
  }, [view, mobileView]);

  // Закрытие меню шапки по клику снаружи
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // Пока где-то "печатают", если за TYPING_EXPIRY_MS не пришло ни новое 'typing',
  // ни 'stop_typing' (вкладка закрылась, сеть оборвалась) — гасим индикатор сами,
  // чтобы он не завис навечно.
  const TYPING_EXPIRY_MS = 4000;
  const typingExpiryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Подключение сокета
  useEffect(() => {
    const expiryTimers = typingExpiryTimers.current;

    const newSocket = io(process.env.REACT_APP_SOCKET_URL || 'http://192.168.24.2', {
        path: process.env.REACT_APP_SOCKET_PATH || '/MirasChatServer/socket.io'
    });
    setSocket(newSocket);

    // На 'connect' (в т.ч. при переподключении после разрыва сети) —
    // заново объявляем себя онлайн и подтягиваем свежее состояние,
    // чтобы после реконнекта не остаться с протухшими данными.
    newSocket.on('connect', () => {
      newSocket.emit('user_online', currentUserId);

      api.get('/users').then(({ data }) => setUsers(data)).catch(console.error);
      api.get('/miras-admins').then(({ data }) => setMirasAdmins(data)).catch(console.error);
      api.get('/unread').then(({ data }) => setUnreadCounts(data)).catch(console.error);
      api.get('/favorites').then(({ data }) => setFavorites(data)).catch(console.error);
      api.get('/comments').then(({ data }) => setComments(data)).catch(console.error);
      api.get('/messages/meta/last').then(({ data }) => setLastMessages(data)).catch(console.error);
    });

    // Список сотрудников/админов не приходит по сокету (нет событий
    // "зарегистрировался"/"удалён") — подтягиваем его периодически, чтобы
    // ростер не застревал в состоянии на момент открытия вкладки.
    const rosterRefreshInterval = setInterval(() => {
      api.get('/users').then(({ data }) => setUsers(data)).catch(console.error);
      api.get('/miras-admins').then(({ data }) => setMirasAdmins(data)).catch(console.error);
    }, 30000);

    newSocket.on('online_users', (userIds: number[]) => setOnlineUsers(userIds));

    newSocket.on('typing', (data: { chatId: string; userId: number; username: string }) => {
      if (data.userId !== currentUserId) {
        setTypingUsers(prev => ({ ...prev, [data.chatId]: data.username }));

        clearTimeout(expiryTimers[data.chatId]);
        expiryTimers[data.chatId] = setTimeout(() => {
          setTypingUsers(prev => {
            const next = { ...prev };
            delete next[data.chatId];
            return next;
          });
        }, TYPING_EXPIRY_MS);
      }
    });

    newSocket.on('stop_typing', (data: { chatId: string; userId: number }) => {
      clearTimeout(expiryTimers[data.chatId]);
      delete expiryTimers[data.chatId];

      setTypingUsers(prev => {
        const next = { ...prev };
        delete next[data.chatId];
        return next;
      });
    });

    newSocket.on('message_status', (data: { id: number; status: 'sent' | 'delivered' | 'read' }) => {
      setMessages(prev => prev.map(m => m.id === data.id ? { ...m, status: data.status } : m));
    });

    // Кто-то мог прочитать сообщения с другого устройства/вкладки того же
    // аккаунта — сервер рассылает это всем, поэтому переспрашиваем счётчики
    // непрочитанных заново, а не просто гасим их локально (надёжнее, чем
    // вручную вычитать конкретные id).
    newSocket.on('message_status_bulk', (data: { chatId: string; messageIds: number[]; status: 'read' }) => {
      setMessages(prev => prev.map(m =>
        data.messageIds.includes(m.id) ? { ...m, status: data.status } : m
      ));

      if (data.status === 'read') {
        api.get('/unread').then(({ data }) => setUnreadCounts(data)).catch(console.error);
      }
    });

    newSocket.on('message_edited', (data: { id: number; chat_id: string; text: string; edited_at: string }) => {
      setMessages(prev => prev.map(m => m.id === data.id ? { ...m, text: data.text, edited_at: data.edited_at } : m));
      setLastMessages(prev => (
        prev[data.chat_id] && prev[data.chat_id].text !== undefined
          ? { ...prev, [data.chat_id]: { ...prev[data.chat_id], text: data.text } }
          : prev
      ));
    });

    newSocket.on('message_deleted', (data: { id: number; chat_id: string }) => {
      setMessages(prev => prev.map(m => m.id === data.id ? { ...m, deleted: true, text: '' } : m));
    });

    // Супер-админ может включить/выключить режим тишины (или сменить роль/группу)
    // прямо во время сессии — применяем сразу, без перелогина.
    newSocket.on('account_updated', (data: { muted?: boolean }) => {
      if (typeof data.muted === 'boolean') {
        setMuted(data.muted);
        localStorage.setItem('muted', String(data.muted));
      }
    });

    // На случай если состояние тишины ещё не долетело (например, включили в
    // другой вкладке) — сервер всё равно не даст отправить, страхуем и тут.
    newSocket.on('message_blocked', (data: { reason?: string }) => {
      if (data.reason === 'muted') {
        setMuted(true);
        localStorage.setItem('muted', 'true');
      }
    });

    return () => {
      Object.values(expiryTimers).forEach(clearTimeout);
      clearInterval(rosterRefreshInterval);
      newSocket.disconnect();
    };
  }, [currentUserId]);

  // Единый обработчик новых сообщений
  useEffect(() => {
    if (!socket) return;

    const handler = (message: Message) => {
      // Добавляем сообщение в список если это активный чат. Дедуп по id —
      // при кратком провисании сети сокет переподключается и на сервере
      // на секунды-две может остаться "зависшая" старая комната того же
      // пользователя, из-за чего событие иногда прилетает дважды; полный
      // перезапуск приложения сам себя чинил именно потому, что React-стейт
      // просто пересоздавался с нуля — а на самом деле дублировалось само
      // событие, а не запись в БД.
      if (message.chat_id === activeChat) {
        setMessages(prev => prev.some(m => m.id === message.id) ? prev : [...prev, message]);
      }

      // Превью последнего сообщения в списке диалогов — обновляем сразу,
      // не дожидаясь перезагрузки страницы.
      if (message.chat_id) {
        setLastMessages(prev => ({
          ...prev,
          [message.chat_id as string]: {
            chat_id: message.chat_id as string,
            text: message.text,
            created_at: message.created_at
          }
        }));
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
          const parsedAdminChat = message.chat_id ? parseAdminChatId(message.chat_id) : null;

          const chatName = message.chat_id === GENERAL_CHAT_ID
            ? 'Общий чат'
            : parsedAdminChat
              ? (isAdmin
                  ? users.find(u => u.id === Number(parsedAdminChat.employeeId))?.username || 'Сотрудник'
                  : parsedAdminChat.login + ' (МИРАС)')
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
      setUnreadCounts(prev => {
          const next = { ...prev };
          delete next[activeChat];
          return next;
      });

      api.get("/unread")
        .then(({ data }) => setUnreadCounts(data))
        .catch(console.error);
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
      dismissMobileNotifications(unreadIds);
    }
  }, [messages, activeChat, socket, currentUserId]);

  // Показ уведомления. На Android WebView обычный Notification API не
  // добирается до системного трея — там нужен нативный мост через Capacitor.
  const showNotification = (message: Message, chatName: string) => {
    if (isNativeMobile) {
      showMobileNotification(message.id, `MirasChat — ${chatName}`, message.text, message.chat_id || '');
      if (socket) socket.emit('message_delivered', message.id);
      return;
    }

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

      // Клик по всплывающему уведомлению — открыть нужный чат и вернуть
      // окно на передний план (на десктопе окно может быть свёрнуто в трей,
      // одного window.focus() из рендерера для этого недостаточно).
      notification.onclick = () => {
        window.electronAPI?.focusWindow?.();
        window.focus();
        if (message.chat_id) handleSelectChat(message.chat_id);
        notification.close();
      };
    }
  };

  const getChatId = (otherUserId: number) => {
    const ids = [currentUserId, otherUserId].sort((a, b) => a - b);
    return `chat_${ids[0]}_${ids[1]}`;
  };

  // "Прочитать всё" — на случай застрявших счётчиков непрочитанного
  // (например, после бага с рассылкой личных сообщений всем подряд).
  const handleMarkAllRead = () => {
    if (!socket) return;
    socket.emit('mark_all_read');
    setUnreadCounts({});
    dismissAllMobileNotifications();
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

  // Объединение локальных пользователей и админов МИРАС.
  // a.id — это уже локальный users.id (сервер сам мапит логин админа на него),
  // поэтому коллизий с id локальных пользователей быть не может.
  const allUsers: AllUser[] = [
    ...users.map(u => ({ id: u.id, username: u.username, source: 'local' as const })),
    ...mirasAdmins.map(a => ({
      id: a.id,
      username: a.login,
      source: 'miras' as const,
      mirasLogin: a.login
    }))
  ];

  const handleSelectChat = (chatId: string) => {
    if (chatId === GENERAL_CHAT_ID) {
      setActiveChat(GENERAL_CHAT_ID);
    } else if (chatId.startsWith(ADMIN_CHAT_PREFIX)) {
      setActiveChat(chatId);
    } else {
      const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === chatId);
      if (user) setActiveChat(chatId);
    }
    setMobileView('chat');
  };

  // Тап по системному уведомлению на Android — открыть тот же чат, откуда
  // пришло сообщение. handleSelectChat пересоздаётся на каждый рендер, поэтому
  // держим актуальную версию в ref и подписываемся на нативное событие один раз.
  const handleSelectChatRef = useRef(handleSelectChat);
  handleSelectChatRef.current = handleSelectChat;

  useEffect(() => {
    return onMobileNotificationTap((chatId) => {
      handleSelectChatRef.current(chatId);
    });
  }, []);

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

  const handleEditMessage = (id: number, text: string) => {
    if (!socket) return;
    socket.emit('message_edit', { id, text });
  };

  const handleDeleteMessage = (id: number) => {
    if (!socket) return;
    socket.emit('message_delete', { id });
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

  const handleDeleteSelf = async () => {
    if (!window.confirm('Удалить свой аккаунт без возможности восстановления? Вся переписка будет удалена.')) {
      return;
    }
    try {
      await api.delete('/users/me');
    } catch (e) {
      console.error('Ошибка удаления аккаунта:', e);
    }
    localStorage.clear();
    window.location.reload();
  };

  const handleProfileSaved = (newUsername: string) => {
    localStorage.setItem('username', newUsername);
    window.location.reload();
  };

  const handleDeleteUser = async (userId: number) => {
    if (!window.confirm('Удалить аккаунт этого сотрудника без возможности восстановления?')) {
      return;
    }
    try {
      await api.delete(`/users/${userId}`);
      setUsers(prev => prev.filter(u => u.id !== userId));
    } catch (e) {
      console.error('Ошибка удаления аккаунта:', e);
      alert('Не удалось удалить аккаунт');
    }
  };

  // Формирование списка чатов: избранные наверху (по свежести), дальше все
  // остальные по времени последнего сообщения — без группировки по разделам.
  const chats = [
    { id: GENERAL_CHAT_ID, name: 'Общий чат', section: 'general' as ChatSection },
    ...allUsers.map(u => {
      const commentData = comments[u.id];
      const displayName = commentData?.comment ? `${commentData.username} (${commentData.comment})` : u.username;

      // Если сам залогинен как админ МИРАС — переписка с сотрудником должна
      // использовать ту же схему id, что и сообщения, пришедшие из панели
      // МИРАС (miras_admin_<свой login>_<id сотрудника>), иначе это два
      // никак не связанных треда и переписка "теряется" для другой стороны.
      return {
        id: u.source === 'miras'
          ? `${ADMIN_CHAT_PREFIX}${u.mirasLogin}_${currentUserId}`
          : isAdmin
            ? `${ADMIN_CHAT_PREFIX}${currentUsername}_${u.id}`
            : getChatId(u.id),
        name: displayName,
        section: (u.source === 'miras' ? 'admin' : 'staff') as ChatSection,
        deletable: u.source === 'local',
        online: u.source === 'local' ? onlineUsers.includes(u.id) : true,
        userId: u.id,
      };
    })
  ]
    .filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    // Сначала избранные (тоже по свежести), потом остальные — все по времени
    // последнего сообщения, без привязки к разделу (админ/сотрудник).
    .sort((a, b) => {
      const aFav = favorites.includes(a.id) ? 1 : 0;
      const bFav = favorites.includes(b.id) ? 1 : 0;
      if (aFav !== bFav) return bFav - aFav;
      const aTime = lastMessages[a.id] ? new Date(lastMessages[a.id].created_at).getTime() : 0;
      const bTime = lastMessages[b.id] ? new Date(lastMessages[b.id].created_at).getTime() : 0;
      return bTime - aTime;
    });

  const typingText = activeChat ? typingUsers[activeChat] : undefined;

  // Данные для шапки переписки — независимо от текущего поискового фильтра списка
  const activeChatMeta: { name: string; section: ChatSection; online?: boolean } | null = (() => {
    if (!activeChat) return null;
    if (activeChat === GENERAL_CHAT_ID) return { name: 'Общий чат', section: 'general' };
    const parsed = parseAdminChatId(activeChat);
    if (parsed) {
      // Сам являюсь админом — собеседник тут сотрудник (id уже зашит в chatId), а не я сам.
      if (isAdmin) {
        const employee = users.find(u => u.id === Number(parsed.employeeId));
        return employee ? { name: employee.username, section: 'staff', online: onlineUsers.includes(employee.id) } : null;
      }
      return { name: parsed.login, section: 'admin', online: true };
    }
    const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === activeChat);
    return user ? { name: user.username, section: 'staff', online: onlineUsers.includes(user.id) } : null;
  })();

  return (
    <div className={'chat-layout' + (mobileView === 'chat' ? ' is-conversation-view' : '')}>
      <ChatList
        username={currentUsername}
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
        onMarkAllRead={handleMarkAllRead}
        isAdmin={isAdmin}
        onDeleteUser={handleDeleteUser}
      />
      <main className="conversation">
        {view === 'settings' ? (
          <SettingsPanel
            username={currentUsername}
            isMirasAccount={isAdmin}
            onClose={() => setView('conversation')}
            onOpenProfile={() => setView('profile')}
            onDeleteAccount={handleDeleteSelf}
            onLogout={handleLogout}
          />
        ) : view === 'profile' ? (
          <ProfileEdit
            currentUsername={currentUsername}
            onBack={() => setView('settings')}
            onSaved={handleProfileSaved}
          />
        ) : (
          <>
            <div className="conv-head">
              <button type="button" className="icon-btn back-btn" onClick={() => setMobileView('list')} aria-label="Назад к списку">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
              </button>

              {activeChatMeta ? (
                <>
                  {activeChatMeta.section === 'general' ? (
                    <div className="avatar avatar-general avatar-sm">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    </div>
                  ) : (
                    <div className="avatar avatar-sm" style={{ background: colorForName(activeChatMeta.name) }}>
                      {initialsForName(activeChatMeta.name)}
                    </div>
                  )}
                  <div className="conv-title">
                    <div className="name">{activeChatMeta.name}</div>
                    <div className={'status' + (activeChatMeta.section === 'general' ? ' is-broadcast' : (activeChatMeta.online ? '' : ' is-offline'))}>
                      {activeChatMeta.section === 'general' ? 'рассылка на всех сотрудников' : (activeChatMeta.online ? 'в сети' : 'не в сети')}
                    </div>
                  </div>
                </>
              ) : (
                <div className="conv-title"><div className="name">Выберите чат</div></div>
              )}

              <div className="menu-wrap" ref={menuRef}>
                <button type="button" className="icon-btn" onClick={() => setMenuOpen(v => !v)} aria-label="Меню">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
                </button>
                {menuOpen && (
                  <div className="menu">
                    <button type="button" onClick={() => { setMenuOpen(false); setView('settings'); }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.36.1.68.3 1 1.55V11a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.6Z" /></svg>
                      Настройки
                    </button>
                    <hr />
                    <button type="button" onClick={() => { setMenuOpen(false); handleLogout(); }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></svg>
                      Выйти
                    </button>
                  </div>
                )}
              </div>
            </div>

            <ChatWindow
              chatId={activeChat}
              messages={messages}
              currentUserId={currentUserId}
              typingUser={typingText}
              onScrollTop={loadMoreMessages}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onEditMessage={handleEditMessage}
              onDeleteMessage={handleDeleteMessage}
            />
            {muted && (
              <div className="muted-banner">
                Ваш аккаунт временно ограничен — отправка сообщений недоступна.
              </div>
            )}
            <MessageInput
              onSend={handleSendMessage}
              onTyping={handleTyping}
              disabled={!activeChat || muted}
            />
          </>
        )}
      </main>
    </div>
  );
};

export default Chat;
