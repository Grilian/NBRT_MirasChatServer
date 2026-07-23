import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { App as CapApp } from '@capacitor/app';
import ChatList, { ChatSection } from '../components/ChatList';
import ChatWindow from '../components/ChatWindow';
import MessageInput from '../components/MessageInput';
import SettingsPanel from '../components/SettingsPanel';
import ProfileEdit from '../components/ProfileEdit';
import DirectoryModal from '../components/DirectoryModal';
import Avatar from '../components/Avatar';
import api from '../api/client';
import { nameFor } from '../utils/user';
import {
  ensureMobileNotificationPermission,
  showMobileNotification,
  isNativeMobile,
  dismissMobileNotifications,
  dismissAllMobileNotifications,
  onMobileNotificationTap
} from '../utils/mobileNotify';

interface User {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  group_id: number | null;
  group_name: string | null;
}
interface Message {
  id: number;
  chat_id?: string;
  text: string;
  sender_id: number;
  username: string;
  display_name?: string | null;
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
  display_name: string | null;
  avatarPath: string | null;
  source: 'local';
  groupName?: string | null;
}

const GENERAL_CHAT_ID = 'general';

const Chat: React.FC = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<number[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [lastMessages, setLastMessages] = useState<Record<string, LastMessage>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [favorites, setFavorites] = useState<string[]>([]);
  const [comments, setComments] = useState<Record<number, { username: string; display_name: string | null; comment: string }>>({});
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<'conversation' | 'settings' | 'profile'>('conversation');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentUserId = Number(localStorage.getItem('userId'));
  const currentUsername = localStorage.getItem('username') || '';
  const currentDisplayName = localStorage.getItem('displayName') || currentUsername;
  const currentAvatarPath = localStorage.getItem('avatarPath') || null;
  const currentBio = localStorage.getItem('bio') || '';
  const currentPhone = localStorage.getItem('phone') || '';

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
      newSocket.emit('user_online', localStorage.getItem('token'));

      api.get('/contacts').then(({ data }) => setUsers(data)).catch(console.error);
      api.get('/unread').then(({ data }) => setUnreadCounts(data)).catch(console.error);
      api.get('/favorites').then(({ data }) => setFavorites(data)).catch(console.error);
      api.get('/comments').then(({ data }) => setComments(data)).catch(console.error);
      api.get('/messages/meta/last').then(({ data }) => setLastMessages(data)).catch(console.error);
    });

    // Список контактов не приходит по сокету целиком (только точечное событие
    // 'contact_added') — подтягиваем его периодически на случай, если событие
    // потерялось (короткий разрыв связи и т.п.), чтобы ростер не застревал в
    // состоянии на момент открытия вкладки.
    const rosterRefreshInterval = setInterval(() => {
      api.get('/contacts').then(({ data }) => setUsers(data)).catch(console.error);
    }, 30000);

    // Кто-то написал впервые (или мы сами добавили из справочника) —
    // обновляем список контактов, не дожидаясь очередного 30-секундного опроса.
    newSocket.on('contact_added', () => {
      api.get('/contacts').then(({ data }) => setUsers(data)).catch(console.error);
    });

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

  // Возврат приложения из фона на Android — пока оно свёрнуто, ОС может
  // оборвать сеть (Doze/App Standby), и сокет повиснет отключённым: его
  // встроенный реконнект теоретически должен сработать сам, но ждать его
  // внутренний backoff не нужно — сразу форсируем попытку и на всякий случай
  // подтягиваем то, что могло не долететь, пока соединение было мертво.
  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;

      if (socket && !socket.connected) {
        socket.connect();
      }

      api.get('/unread').then(({ data }) => setUnreadCounts(data)).catch(console.error);

      if (activeChat) {
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
      }
    });
    return () => { listenerPromise.then((h) => h.remove()); };
  }, [socket, activeChat]);

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
          const otherUser = allUsers.find(u => getChatId(u.id) === message.chat_id);
          const chatName = message.chat_id === GENERAL_CHAT_ID
            ? 'Общий чат'
            : (otherUser ? nameFor(otherUser) : 'Чат');

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
          [targetUserId]: { username: user.username, display_name: user.display_name, comment }
        }));
      }
    } catch (e) {
      console.error('Ошибка:', e);
    }
  };

  const allUsers: AllUser[] = users.map(u => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatarPath: u.avatar_path,
    source: 'local' as const,
    groupName: u.group_name,
  }));

  const handleSelectChat = (chatId: string) => {
    if (chatId === GENERAL_CHAT_ID) {
      setActiveChat(GENERAL_CHAT_ID);
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
        text,
      });
      socket.emit('stop_typing', { chatId: activeChat, userId: currentUserId });
    }
  };

  // Начать чат с кем-то из справочника — контакт появляется в своём списке
  // сразу (без ожидания первого сообщения); у собеседника — только когда
  // сообщение реально отправлено (см. серверную автоподписку).
  const handleStartChat = async (user: { id: number; username: string; display_name: string | null; avatar_path: string | null; group_id: number | null; group_name: string | null }) => {
    setUsers(prev => prev.some(u => u.id === user.id) ? prev : [...prev, user]);
    setDirectoryOpen(false);
    setActiveChat(getChatId(user.id));
    setMobileView('chat');
    try {
      await api.post(`/contacts/${user.id}`);
    } catch (e) {
      console.error('Ошибка добавления контакта:', e);
    }
  };

  const handleRemoveContact = async (userId: number) => {
    if (activeChat === getChatId(userId)) {
      setActiveChat(null);
      setMobileView('list');
    }
    setUsers(prev => prev.filter(u => u.id !== userId));
    try {
      await api.delete(`/contacts/${userId}`);
    } catch (e) {
      console.error('Ошибка удаления контакта:', e);
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
        username: currentDisplayName,
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

  const handleProfileSaved = (profile: { username: string; display_name: string; avatar_path: string | null; bio: string; phone: string }) => {
    localStorage.setItem('username', profile.username);
    localStorage.setItem('displayName', profile.display_name);
    localStorage.setItem('avatarPath', profile.avatar_path || '');
    localStorage.setItem('bio', profile.bio);
    localStorage.setItem('phone', profile.phone);
    window.location.reload();
  };

  // Реальные группы (настроены в панели супер-админа) — упорядочиваем по
  // алфавиту, чтобы разделы в списке не прыгали местами между рендерами.
  const realGroupNames = Array.from(
    new Set(
      allUsers
        .filter(u => u.source === 'local' && u.groupName)
        .map(u => u.groupName as string)
    )
  ).sort((a, b) => a.localeCompare(b, 'ru'));

  function groupRank(c: { id: string; section: ChatSection; groupLabel: string | null }) {
    if (c.section === 'general') return -1;
    if (favorites.includes(c.id)) return 0;
    // groupLabel у "безгруппных" — это плейсхолдер "Без группы", а не реальное
    // название группы. truthy-проверка тут не годится: indexOf вернёт -1,
    // и 2 + (-1) = 0 столкнёт их с избранными вместо конца списка.
    const idx = realGroupNames.indexOf(c.groupLabel || '');
    if (idx !== -1) return 1 + idx;
    return 1 + realGroupNames.length; // "Без группы" — всегда последними
  }

  // Формирование списка чатов: Общий чат — всегда первым, дальше избранные
  // (по свежести), затем реальные группы (настроены в панели супер-админа),
  // внутри каждой — тоже по свежести.
  const chats = [
    { id: GENERAL_CHAT_ID, name: 'Общий чат', section: 'general' as ChatSection, groupLabel: null as string | null },
    ...allUsers.map(u => {
      const commentData = comments[u.id];
      const baseName = nameFor(u);
      const rowName = commentData?.comment ? `${baseName} (${commentData.comment})` : baseName;

      return {
        id: getChatId(u.id),
        name: rowName,
        section: 'staff' as ChatSection,
        groupLabel: u.groupName || 'Без группы',
        deletable: true,
        online: onlineUsers.includes(u.id),
        userId: u.id,
        avatarPath: u.avatarPath,
      };
    })
  ]
    .filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      const rankDiff = groupRank(a) - groupRank(b);
      if (rankDiff !== 0) return rankDiff;
      const aTime = lastMessages[a.id] ? new Date(lastMessages[a.id].created_at).getTime() : 0;
      const bTime = lastMessages[b.id] ? new Date(lastMessages[b.id].created_at).getTime() : 0;
      return bTime - aTime;
    })
    // Избранным — свой ярлык раздела, чтобы не путался с их реальной группой.
    .map(c => ({ ...c, groupLabel: c.section !== 'general' && favorites.includes(c.id) ? 'Избранное' : c.groupLabel }));

  const typingText = activeChat ? typingUsers[activeChat] : undefined;

  // Данные для шапки переписки — независимо от текущего поискового фильтра списка
  const activeChatMeta: { name: string; section: ChatSection; online?: boolean; avatarPath?: string | null } | null = (() => {
    if (!activeChat) return null;
    if (activeChat === GENERAL_CHAT_ID) return { name: 'Общий чат', section: 'general' };
    const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === activeChat);
    return user ? { name: nameFor(user), section: 'staff', online: onlineUsers.includes(user.id), avatarPath: user.avatarPath } : null;
  })();

  return (
    <div className={'chat-layout' + (mobileView === 'chat' ? ' is-conversation-view' : '')}>
      <ChatList
        username={currentDisplayName}
        avatarPath={currentAvatarPath}
        chats={chats}
        activeChat={activeChat}
        onSelectChat={handleSelectChat}
        onOpenDirectory={() => setDirectoryOpen(true)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        lastMessages={lastMessages}
        unreadCounts={unreadCounts}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onUpdateComment={updateComment}
        comments={comments}
        onMarkAllRead={handleMarkAllRead}
        onRemoveContact={handleRemoveContact}
      />
      {directoryOpen && (
        <DirectoryModal
          existingContactIds={users.map(u => u.id)}
          onClose={() => setDirectoryOpen(false)}
          onSelectUser={handleStartChat}
        />
      )}
      <main className="conversation">
        {view === 'settings' ? (
          <SettingsPanel
            username={currentDisplayName}
            avatarPath={currentAvatarPath}
            onClose={() => setView('conversation')}
            onOpenProfile={() => setView('profile')}
            onDeleteAccount={handleDeleteSelf}
            onLogout={handleLogout}
          />
        ) : view === 'profile' ? (
          <ProfileEdit
            currentUsername={currentUsername}
            currentDisplayName={currentDisplayName}
            currentAvatarPath={currentAvatarPath}
            currentBio={currentBio}
            currentPhone={currentPhone}
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
                  <Avatar
                    name={activeChatMeta.name}
                    avatarPath={activeChatMeta.avatarPath}
                    size="sm"
                    isGeneral={activeChatMeta.section === 'general'}
                  />
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
