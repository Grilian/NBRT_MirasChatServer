import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { App as CapApp } from '@capacitor/app';
import ChatList, { ChatSection } from '../components/ChatList';
import ChatWindow from '../components/ChatWindow';
import MessageInput from '../components/MessageInput';
import SettingsPanel from '../components/SettingsPanel';
import ProfileEdit from '../components/ProfileEdit';
import DirectoryModal from '../components/DirectoryModal';
import UserInfoModal from '../components/UserInfoModal';
import Avatar from '../components/Avatar';
import NavRail, { SectionId, sectionById } from '../components/NavRail';
import SectionStub from '../components/SectionStub';
import PeopleSection from '../components/PeopleSection';
import NotificationStack, { ToastNotification } from '../components/NotificationStack';
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
import {
  ensureDesktopNotificationPermission,
  showDesktopNotification,
  dismissDesktopNotification,
  dismissAllDesktopNotifications
} from '../utils/desktopNotify';
import { playIncomingSound, primeNotificationSound } from '../utils/sound';
import {
  NotificationPrefs,
  getNotificationPrefs,
  onNotificationPrefsChanged
} from '../utils/notificationPrefs';

interface User {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  bio: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  birth_date: string | null;
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
  bio: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  birthDate: string | null;
  source: 'local';
  groupName?: string | null;
}

const GENERAL_CHAT_ID = 'general';

// Больше четырёх карточек на экране — уже не уведомление, а стена, за которой
// не видно приложения. Самые старые уступают место новым (в них всё равно
// показано только последнее сообщение чата).
const MAX_TOASTS = 4;

// chat_id личной переписки детерминированно собирается из пары id — одинаково
// на клиенте и на сервере (см. services/chatParticipants.js).
function chatIdFor(a: number, b: number): string {
  const ids = [a, b].sort((x, y) => x - y);
  return `chat_${ids[0]}_${ids[1]}`;
}

const Chat: React.FC = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  // Собственный статус в рельсе: «Онлайн» показываем только при живом сокете —
  // иначе он врал бы при обрыве связи, когда сообщения уже никуда не уходят.
  const [socketConnected, setSocketConnected] = useState(false);
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
  // Верхний уровень навигации — раздел из рельса. Внутри «Настроек» есть свой
  // подэкран «Профиль», поэтому он отдельным состоянием, а не восьмым разделом:
  // в рельсе профиль открывается тем же пунктом «Настройки».
  const [section, setSection] = useState<SectionId>('chats');
  const [settingsView, setSettingsView] = useState<'settings' | 'profile'>('settings');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [infoModalUserId, setInfoModalUserId] = useState<number | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentAt = useRef(0);
  // Синхронная защёлка «страница истории уже грузится» — см. loadMoreMessages
  const loadingMoreRef = useRef(false);

  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(getNotificationPrefs);

  // Окно «в фокусе» — не просто document.hasFocus() в момент прихода
  // сообщения, а реактивное состояние: от него зависит и показ уведомления, и
  // (главное) можно ли отмечать сообщения прочитанными. Раньше прочитанными
  // они помечались всегда, как только попадали в открытый чат — даже если
  // человек отошёл от компьютера или окно было свёрнуто в трей. Из-за этого
  // счётчик непрочитанного не появлялся вовсе, а собеседник видел «прочитано»
  // у сообщения, которое никто не читал.
  const [windowFocused, setWindowFocused] = useState(
    typeof document !== 'undefined' ? document.hasFocus() && document.visibilityState !== 'hidden' : true
  );

  // «Переписку действительно видно на экране»: мало открытого чата и фокуса
  // окна — поверх переписки могут быть открыты Настройки или Профиль, а на
  // узком экране можно уйти назад к списку чатов, не закрывая сам чат. Во всех
  // этих случаях сообщение человеку не видно, значит его нельзя считать
  // прочитанным и нельзя проглатывать уведомление о нём.
  const conversationVisible = windowFocused && section === 'chats' && mobileView === 'chat';

  const currentUserId = Number(localStorage.getItem('userId'));

  // Живой снимок состояния для обработчика сокета — см. подробности там же.
  const liveRef = useRef({
    activeChat: null as string | null,
    allUsers: [] as AllUser[],
    windowFocused: true,
    conversationVisible: false,
    prefs: notificationPrefs,
  });

  // id сообщений, уже учтённых в счётчике непрочитанного — защита от повторного
  // прихода того же события 'chat_message' при переподключении сокета.
  const countedMessageIds = useRef<Set<number>>(new Set());

  // Уведомления копятся по чатам: второе сообщение из того же чата не плодит
  // новую карточку, а обновляет существующую и заново запускает её таймер —
  // как стопка уведомлений в Telegram.
  const pushToast = useCallback((incoming: Omit<ToastNotification, 'count' | 'revision'>) => {
    setToasts(prev => {
      const existing = prev.find(t => t.chatId === incoming.chatId);
      if (existing) {
        return prev.map(t => t.chatId === incoming.chatId
          ? { ...t, ...incoming, count: t.count + 1, revision: t.revision + 1 }
          : t);
      }
      return [...prev, { ...incoming, count: 1, revision: 0 }].slice(-MAX_TOASTS);
    });
  }, []);

  const dismissToast = useCallback((chatId: string) => {
    setToasts(prev => prev.filter(t => t.chatId !== chatId));
    dismissDesktopNotification(chatId);
  }, []);

  // Стейт, а не просто чтение localStorage на каждый рендер — иначе смену
  // аватара/имени в профиле пришлось бы отражать через полный reload
  // страницы (что выглядело как "окно закрылось"), а не мгновенно на месте.
  const [currentUsername, setCurrentUsername] = useState(localStorage.getItem('username') || '');
  const [currentDisplayName, setCurrentDisplayName] = useState(localStorage.getItem('displayName') || localStorage.getItem('username') || '');
  const [currentAvatarPath, setCurrentAvatarPath] = useState<string | null>(localStorage.getItem('avatarPath') || null);
  const [currentBio, setCurrentBio] = useState(localStorage.getItem('bio') || '');
  const [currentPhone, setCurrentPhone] = useState(localStorage.getItem('phone') || '');
  const [currentDepartment, setCurrentDepartment] = useState(localStorage.getItem('department') || '');
  const [currentPosition, setCurrentPosition] = useState(localStorage.getItem('position') || '');
  const [currentBirthDate, setCurrentBirthDate] = useState(localStorage.getItem('birthDate') || '');
  // Роль "Администратор" открывает встроенное админ-управление в профиле
  // собеседника (см. UserInfoModal) — тоже может смениться живьём по сокету.
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(localStorage.getItem('role') || null);
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);

  // Режим тишины — суперадмин может включить/выключить прямо во время сессии,
  // поэтому актуальное значение приходит и живьём по сокету (см. account_updated).
  const [muted, setMuted] = useState(localStorage.getItem('muted') === 'true');

  // Запрос разрешения на уведомления
  useEffect(() => {
    ensureDesktopNotificationPermission();
    ensureMobileNotificationPermission();
    primeNotificationSound();
  }, []);

  // Настройки уведомлений меняются в панели настроек — подхватываем сразу,
  // без перезахода в приложение.
  useEffect(() => onNotificationPrefsChanged(setNotificationPrefs), []);

  // Фокус окна. visibilitychange нужен отдельно от blur: свёрнутое окно и
  // фоновая вкладка не всегда дают blur, а в Electron окно, спрятанное в
  // трей, вообще не проходит через веб-события — оттуда состояние приходит
  // из main-процесса (см. window:focus-changed).
  useEffect(() => {
    const update = () => setWindowFocused(document.hasFocus() && document.visibilityState !== 'hidden');

    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    const unsubscribeElectron = window.electronAPI?.onFocusChange?.((isFocused) => setWindowFocused(isFocused));

    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      unsubscribeElectron?.();
    };
  }, []);

  // Список групп нужен только для встроенного админ-управления в профиле —
  // подтягиваем один раз, когда роль оказывается "Администратор" (в том
  // числе если её только что назначили живьём, без перелогина).
  useEffect(() => {
    if (currentUserRole !== 'admin') return;
    api.get('/moderation/groups').then(({ data }) => setGroups(data)).catch(console.error);
  }, [currentUserRole]);

  // Красная точка в трее/оверлей на таскбаре (desktop) и счётчик в заголовке
  // вкладки (веб) — пока есть непрочитанное. Заголовок вкладки для веб-версии
  // единственный индикатор, который виден, когда вкладка не активна.
  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
  useEffect(() => {
    window.electronAPI?.setUnreadBadge(totalUnread);
    document.title = totalUnread > 0 ? `(${totalUnread}) MirasChat` : 'MirasChat';
  }, [totalUnread]);

  // Аппаратная кнопка "назад" на Android — по умолчанию сразу закрывала бы
  // приложение (нет истории браузера). Идём по своему стеку экранов:
  // профиль -> настройки -> любой другой раздел -> чаты -> список чатов,
  // и только с самого списка сворачиваем приложение, а не убиваем процесс.
  //
  // Подписку вешаем ровно один раз, а текущий экран читаем из ref. Раньше
  // эффект пересоздавал листенер на каждую смену раздела, и это приводило к
  // залипанию: и addListener, и remove() ходят в нативную часть асинхронно,
  // поэтому старая подписка могла пережить свою отмену (например, если
  // приложение свернули ровно в этот момент — мост встаёт вместе с WebView).
  // Дальше на "назад" срабатывали обе, причём осиротевшая — первой, со своим
  // замороженным состоянием: она видела mobileView === 'list' при открытом
  // чате и сворачивала приложение вместо возврата к списку. Разворачиваешь —
  // тот же открытый чат, "назад" снова сворачивает, и так до полного
  // закрытия приложения.
  const backNavRef = useRef({ section, settingsView, mobileView, directoryOpen, infoModalUserId });
  backNavRef.current = { section, settingsView, mobileView, directoryOpen, infoModalUserId };

  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('backButton', () => {
      const nav = backNavRef.current;
      // Модалки поверх всего — закрываются первыми, иначе "назад" уводил
      // экран из-под открытого окна, а само окно оставалось висеть.
      if (nav.infoModalUserId !== null) { setInfoModalUserId(null); return; }
      if (nav.directoryOpen) { setDirectoryOpen(false); return; }
      if (nav.section === 'settings' && nav.settingsView === 'profile') { setSettingsView('settings'); return; }
      if (nav.section !== 'chats') { setSection('chats'); return; }
      if (nav.mobileView === 'chat') { setMobileView('list'); return; }
      CapApp.minimizeApp();
    });
    return () => { listenerPromise.then((h) => h.remove()); };
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
    newSocket.on('disconnect', () => setSocketConnected(false));

    newSocket.on('connect', () => {
      setSocketConnected(true);
      newSocket.emit('user_online', localStorage.getItem('token'));

      // Подтягиваем свой профиль целиком — сессии обычных пользователей не
      // истекают и не переиздаются, так что это единственный способ подобрать
      // поля, добавленные в приложение уже после того, как человек залогинился
      // (например, role для встроенного админ-управления), без перелогина.
      api.get('/users/me').then(({ data }) => {
        setCurrentUsername(data.username);
        setCurrentDisplayName(data.display_name);
        setCurrentAvatarPath(data.avatar_path);
        setCurrentBio(data.bio);
        setCurrentPhone(data.phone);
        setCurrentDepartment(data.department);
        setCurrentPosition(data.position);
        setCurrentBirthDate(data.birth_date);
        setCurrentUserRole(data.role);
        setMuted(data.muted);
        localStorage.setItem('username', data.username);
        localStorage.setItem('displayName', data.display_name);
        localStorage.setItem('avatarPath', data.avatar_path || '');
        localStorage.setItem('bio', data.bio || '');
        localStorage.setItem('phone', data.phone || '');
        localStorage.setItem('department', data.department || '');
        localStorage.setItem('position', data.position || '');
        localStorage.setItem('birthDate', data.birth_date || '');
        localStorage.setItem('role', data.role || '');
        localStorage.setItem('muted', String(data.muted));
      }).catch(console.error);

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

      // Превью в списке чатов раньше не трогали — и удалённое сообщение
      // продолжало висеть там своим текстом, хотя в самой переписке уже
      // отображалось как «Сообщение удалено». Перечитываем превью с сервера:
      // локально мы не знаем, какое сообщение стало последним, если удалили
      // как раз его.
      api.get('/messages/meta/last').then(({ data }) => setLastMessages(data)).catch(console.error);
    });

    // Супер-админ (или теперь и обычный "Администратор" из профиля) может
    // включить/выключить режим тишины или сменить роль/группу/тип прямо во
    // время сессии — применяем сразу, без перелогина. Это всегда про самого
    // себя: сервер шлёт это только в комнату 'user:<id>' затронутого.
    newSocket.on('account_updated', (data: { muted?: boolean; role?: string | null }) => {
      if (typeof data.muted === 'boolean') {
        setMuted(data.muted);
        localStorage.setItem('muted', String(data.muted));
      }
      if (data.role !== undefined) {
        setCurrentUserRole(data.role);
        localStorage.setItem('role', data.role || '');
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

  // Единый обработчик новых сообщений.
  //
  // Подписка живёт ровно столько же, сколько сокет, а всё изменчивое состояние
  // обработчик читает через liveRef. Раньше он пересоздавался по
  // [socket, activeChat, currentUserId], но при этом обращался ещё и к
  // allUsers — то есть навсегда запоминал список контактов на момент
  // подписки. Из-за этого уведомление от человека, добавленного в контакты
  // уже после открытия приложения, приходило с безликим заголовком «Чат»
  // вместо имени отправителя.
  useEffect(() => {
    if (!socket) return;

    const handler = (message: Message) => {
      const { activeChat: liveActiveChat, allUsers: liveUsers, windowFocused: focused, conversationVisible, prefs } = liveRef.current;
      const chatId = message.chat_id;
      const isMine = message.sender_id === currentUserId;
      const isActiveChat = !!chatId && chatId === liveActiveChat;

      // «Человек прямо сейчас это видит»: мало того, что чат открыт — окно
      // должно быть в фокусе, а сама переписка не закрыта настройками или
      // списком чатов. Свёрнутое в трей окно с открытым чатом раньше
      // считалось просмотром, и сообщение молча проглатывалось: без
      // счётчика, без уведомления, сразу «прочитано».
      const isVisibleNow = isActiveChat && conversationVisible;

      // Добавляем сообщение в список если это активный чат. Дедуп по id —
      // при кратком провисании сети сокет переподключается и на сервере
      // на секунды-две может остаться "зависшая" старая комната того же
      // пользователя, из-за чего событие иногда прилетает дважды; полный
      // перезапуск приложения сам себя чинил именно потому, что React-стейт
      // просто пересоздавался с нуля — а на самом деле дублировалось само
      // событие, а не запись в БД.
      if (isActiveChat) {
        setMessages(prev => prev.some(m => m.id === message.id) ? prev : [...prev, message]);
      }

      // Превью последнего сообщения в списке диалогов — обновляем сразу,
      // не дожидаясь перезагрузки страницы.
      if (chatId) {
        setLastMessages(prev => ({
          ...prev,
          [chatId]: { chat_id: chatId, text: message.text, created_at: message.created_at }
        }));
      }

      if (isMine || !chatId) return;

      // Счётчик непрочитанного. Дедуп по id обязателен и здесь: то самое
      // задвоенное событие раньше давало +2 к счётчику, и лишняя единица
      // висела до перезахода — в списке чатов бейдж показывал больше
      // сообщений, чем в чате реально есть.
      if (!isVisibleNow && !countedMessageIds.current.has(message.id)) {
        if (countedMessageIds.current.size > 2000) countedMessageIds.current.clear();
        countedMessageIds.current.add(message.id);
        setUnreadCounts(prev => ({ ...prev, [chatId]: (prev[chatId] || 0) + 1 }));
      }

      if (isVisibleNow || !prefs.enabled) return;

      const otherUser = liveUsers.find(u => chatIdFor(currentUserId, u.id) === chatId);
      const isGeneral = chatId === GENERAL_CHAT_ID;
      const chatName = isGeneral ? 'Общий чат' : (otherUser ? nameFor(otherUser) : nameFor(message));

      // В общем чате важно, кто именно написал — иначе все уведомления
      // выглядят одинаково и по ним не понять, стоит ли отвлекаться.
      const body = isGeneral ? `${nameFor(message)}: ${message.text}` : message.text;

      // На мобильном в фоне звук играет сама ОС по каналу уведомления —
      // свой в этот момент не воспроизвести (приложение усыплено), да и
      // дублировать его не нужно.
      if (prefs.sound && (!isNativeMobile || focused)) {
        playIncomingSound();
      }

      pushToast({
        chatId,
        title: chatName,
        body,
        avatarPath: otherUser?.avatarPath ?? null,
        isGeneral
      });

      if (!focused) {
        if (isNativeMobile) {
          showMobileNotification(message.id, `MirasChat — ${chatName}`, body, chatId);
        } else if (prefs.system) {
          showDesktopNotification({
            title: chatName,
            body,
            tag: chatId,
            onClick: () => {
              window.electronAPI?.focusWindow?.();
              window.focus();
              handleSelectChatRef.current(chatId);
            }
          });
        }
        // Мигание кнопки в панели задач — окно может быть свёрнуто в трей,
        // и уведомление ОС человек мог не застать.
        window.electronAPI?.flashWindow?.();
      }
    };

    socket.on('chat_message', handler);
    return () => { socket.off('chat_message', handler); };
  }, [socket, currentUserId, pushToast]);

  // Загрузка истории при смене чата
  useEffect(() => {
    if (activeChat) {
      // Ответ на запрос истории может прийти уже после того, как человек
      // переключился на другой чат (медленная сеть, быстрые клики по списку).
      // Без этой отсечки история чата A применялась поверх открытого чата B —
      // и дальше живые сообщения B дописывались к чужой переписке.
      let cancelled = false;

      setMessages([]);
      setHasMore(true);
      loadingMoreRef.current = false;
      api.get(`/messages/${activeChat}?limit=50&offset=0`)
        .then(({ data }) => {
          if (cancelled) return;
          if (data.messages) {
            setMessages(data.messages);
            setHasMore(data.hasMore);
          } else {
            setMessages(data);
            setHasMore(false);
          }
        })
        .catch(console.error);
      // Счётчик открытого чата гасим локально и не даём серверному ответу
      // его вернуть. Раньше здесь безусловно применялся свежий /unread, а он
      // в этот момент ещё считает чат непрочитанным (сообщения помечаются
      // прочитанными чуть позже, отдельным событием) — бейдж успевал моргнуть
      // обратно и погаснуть только со второго круга.
      setUnreadCounts(prev => {
          const next = { ...prev };
          delete next[activeChat];
          return next;
      });

      api.get("/unread")
        .then(({ data }) => setUnreadCounts({ ...data, [activeChat]: 0 }))
        .catch(console.error);

      return () => { cancelled = true; };
    } else {
      setMessages([]);
    }
  }, [activeChat]);

  // Подгрузка старых сообщений. Курсор — id самого старого показанного
  // сообщения, а не offset по длине списка: пока человек читает историю, в чат
  // приходят новые сообщения, из-за чего offset «съезжал» и следующая страница
  // либо дублировала уже показанное, либо перепрыгивала через кусок переписки.
  //
  // Защёлка — ref, а не стейт loadingMore. Именно на этом рождались
  // задвоенные сообщения: onScroll стреляет десятки раз за секунду, а
  // setLoadingMore(true) применяется только к следующему рендеру, поэтому
  // события, успевшие до перерисовки, читали из замыкания старое
  // loadingMore === false и запускали загрузку повторно — с тем же оффсетом.
  // Одна и та же страница дописывалась в список дважды, и дубликаты жили до
  // перезахода в приложение (перезаход просто перечитывал историю с сервера).
  // Ref обновляется синхронно, поэтому второй вызов отсекается сразу.
  const loadMoreMessages = async () => {
    if (!activeChat || loadingMoreRef.current || !hasMore || messages.length === 0) return;

    const oldestId = messages[0].id;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const { data } = await api.get(`/messages/${activeChat}?limit=50&before=${oldestId}`);
      if (data.messages) {
        // Второй пояс к защёлке: даже если страница каким-то образом придёт
        // дважды, уже показанные id отсеются и в список ничего не задвоится.
        setMessages(prev => {
          const known = new Set(prev.map(m => m.id));
          const fresh = data.messages.filter((m: Message) => !known.has(m.id));
          return fresh.length ? [...fresh, ...prev] : prev;
        });
        setHasMore(data.hasMore);
      }
    } catch (e) {
      console.error('Ошибка загрузки:', e);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // Отметка прочитанных — только когда человек действительно смотрит в окно.
  // Гейт по windowFocused и есть исправление: раньше сообщение, пришедшее в
  // открытый чат у свёрнутого окна, немедленно становилось «прочитанным».
  // Собеседник видел две синие галочки, хотя за компьютером никого не было, а
  // сам получатель не получал ни счётчика, ни следа о пропущенном сообщении.
  // Эффект перезапускается при возврате фокуса, так что отметка произойдёт
  // ровно в тот момент, когда человек вернулся к окну.
  useEffect(() => {
    if (!socket || !activeChat || !conversationVisible || messages.length === 0) return;

    const unreadIds = messages
      .filter(m => m.sender_id !== currentUserId && m.status !== 'read')
      .map(m => m.id);

    if (unreadIds.length > 0) {
      socket.emit('message_read', { chatId: activeChat, messageIds: unreadIds });
      dismissMobileNotifications(unreadIds);
    }

    // Открытый и просматриваемый чат не должен светиться в списке
    // непрочитанным и держать всплывающее уведомление на экране.
    setUnreadCounts(prev => {
      if (!prev[activeChat]) return prev;
      const next = { ...prev };
      delete next[activeChat];
      return next;
    });
    dismissToast(activeChat);
  }, [messages, activeChat, socket, currentUserId, conversationVisible, dismissToast]);

  const getChatId = (otherUserId: number) => chatIdFor(currentUserId, otherUserId);

  // "Прочитать всё" — на случай застрявших счётчиков непрочитанного
  // (например, после бага с рассылкой личных сообщений всем подряд).
  const handleMarkAllRead = () => {
    if (!socket) return;
    socket.emit('mark_all_read');
    setUnreadCounts({});
    setToasts([]);
    dismissAllMobileNotifications();
    dismissAllDesktopNotifications();
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
    bio: u.bio,
    phone: u.phone,
    department: u.department,
    position: u.position,
    birthDate: u.birth_date,
    source: 'local' as const,
    groupName: u.group_name,
  }));

  // Обновляем снимок для обработчика сокета на каждом рендере — присваивание
  // должно идти после объявления allUsers, иначе получим TDZ.
  liveRef.current = { activeChat, allUsers, windowFocused, conversationVisible, prefs: notificationPrefs };

  const handleSelectChat = (chatId: string) => {
    if (chatId === GENERAL_CHAT_ID) {
      setActiveChat(GENERAL_CHAT_ID);
    } else {
      const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === chatId);
      if (user) setActiveChat(chatId);
    }
    setMobileView('chat');
    // Открытые Настройки/Профиль/другой раздел иначе продолжали закрывать собой
    // область переписки — activeChat менялся, а видимая панель оставалась прежней.
    setSection('chats');
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
    setUsers(prev => prev.some(u => u.id === user.id) ? prev : [...prev, { ...user, bio: null, phone: null, department: null, position: null, birth_date: null }]);
    setDirectoryOpen(false);
    setActiveChat(getChatId(user.id));
    setMobileView('chat');
    setSection('chats');
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
    if (!socket || !activeChat) return;

    // Событие 'typing' уходило на каждое нажатие клавиши — при быстром наборе
    // это десятки сокет-сообщений в секунду каждому участнику чата, полностью
    // бесполезных: индикатор у собеседника всё равно уже горит. Шлём не чаще
    // раза в секунду, при этом таймер «перестал печатать» продлеваем всегда.
    const now = Date.now();
    if (now - lastTypingSentAt.current > 1000) {
      lastTypingSentAt.current = now;
      socket.emit('typing', {
        chatId: activeChat,
        userId: currentUserId,
        username: currentDisplayName,
      });
    }

    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      lastTypingSentAt.current = 0;
      socket.emit('stop_typing', { chatId: activeChat, userId: currentUserId });
    }, 2000);
  };

  const handleLogout = () => {
    // Уведомления от прошлого аккаунта не должны пережить выход — системные
    // карточки живут вне окна и с requireInteraction висят, пока их не закроют.
    dismissAllDesktopNotifications();
    dismissAllMobileNotifications();
    window.electronAPI?.setUnreadBadge(0);
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

  const handleProfileSaved = (profile: {
    username: string; display_name: string; avatar_path: string | null; bio: string; phone: string;
    department: string; position: string; birth_date: string;
  }) => {
    localStorage.setItem('username', profile.username);
    localStorage.setItem('displayName', profile.display_name);
    localStorage.setItem('avatarPath', profile.avatar_path || '');
    localStorage.setItem('bio', profile.bio);
    localStorage.setItem('phone', profile.phone);
    localStorage.setItem('department', profile.department);
    localStorage.setItem('position', profile.position);
    localStorage.setItem('birthDate', profile.birth_date);
    setCurrentUsername(profile.username);
    setCurrentDisplayName(profile.display_name);
    setCurrentAvatarPath(profile.avatar_path);
    setCurrentBio(profile.bio);
    setCurrentPhone(profile.phone);
    setCurrentDepartment(profile.department);
    setCurrentPosition(profile.position);
    setCurrentBirthDate(profile.birth_date);
  };

  // Аватар меняется отдельно от остальной формы (загрузка файла сразу же,
  // без ожидания кнопки "Сохранить") — своё лёгкое обновление, тоже без reload.
  const handleAvatarChanged = (avatarPath: string | null) => {
    localStorage.setItem('avatarPath', avatarPath || '');
    setCurrentAvatarPath(avatarPath);
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
  const activeChatMeta: { name: string; section: ChatSection; online?: boolean; avatarPath?: string | null; userId?: number } | null = (() => {
    if (!activeChat) return null;
    if (activeChat === GENERAL_CHAT_ID) return { name: 'Общий чат', section: 'general' };
    const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === activeChat);
    return user ? { name: nameFor(user), section: 'staff', online: onlineUsers.includes(user.id), avatarPath: user.avatarPath, userId: user.id } : null;
  })();

  const infoModalUser = infoModalUserId ? allUsers.find(u => u.id === infoModalUserId) : null;

  const isChats = section === 'chats';
  const activeSection = sectionById(section);

  const openOwnProfile = () => { setSection('settings'); setSettingsView('profile'); };

  return (
    <div className={'chat-layout'
      + (isChats ? '' : ' is-single-pane')
      + (isChats && mobileView === 'chat' ? ' is-conversation-view' : '')}>
      <NotificationStack
        toasts={toasts}
        durationMs={notificationPrefs.durationMs}
        onOpen={(chatId) => { handleSelectChat(chatId); dismissToast(chatId); }}
        onDismiss={dismissToast}
      />

      <NavRail
        active={section}
        onSelect={(id) => {
          setSection(id);
          // Возврат в «Настройки» всегда открывает сам список настроек, а не
          // подэкран профиля, на котором человек был в прошлый раз.
          if (id === 'settings') setSettingsView('settings');
        }}
        unreadTotal={totalUnread}
        username={currentDisplayName}
        avatarPath={currentAvatarPath}
        online={socketConnected}
        onOpenProfile={openOwnProfile}
      />

      {isChats && (
      <ChatList
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
        onOpenUserInfo={(userId) => setInfoModalUserId(userId)}
      />
      )}
      {directoryOpen && (
        <DirectoryModal
          existingContactIds={users.map(u => u.id)}
          onClose={() => setDirectoryOpen(false)}
          onSelectUser={handleStartChat}
        />
      )}
      {infoModalUser && (
        <UserInfoModal
          user={{
            id: infoModalUser.id,
            username: infoModalUser.username,
            display_name: infoModalUser.display_name,
            avatarPath: infoModalUser.avatarPath,
            groupName: infoModalUser.groupName,
            bio: infoModalUser.bio,
            phone: infoModalUser.phone,
            department: infoModalUser.department,
            position: infoModalUser.position,
            birthDate: infoModalUser.birthDate,
          }}
          online={onlineUsers.includes(infoModalUser.id)}
          canModerate={currentUserRole === 'admin'}
          groups={groups}
          onClose={() => setInfoModalUserId(null)}
          onMessage={() => {
            handleSelectChat(getChatId(infoModalUser.id));
            setInfoModalUserId(null);
          }}
        />
      )}
      {section === 'settings' && (
        <main className="section-host">
          {settingsView === 'profile' ? (
            <ProfileEdit
              currentUsername={currentUsername}
              currentDisplayName={currentDisplayName}
              currentAvatarPath={currentAvatarPath}
              currentBio={currentBio}
              currentPhone={currentPhone}
              currentDepartment={currentDepartment}
              currentPosition={currentPosition}
              currentBirthDate={currentBirthDate}
              onBack={() => setSettingsView('settings')}
              onSaved={handleProfileSaved}
              onAvatarChanged={handleAvatarChanged}
            />
          ) : (
            <SettingsPanel
              username={currentDisplayName}
              avatarPath={currentAvatarPath}
              onClose={() => setSection('chats')}
              onOpenProfile={() => setSettingsView('profile')}
              onDeleteAccount={handleDeleteSelf}
              onLogout={handleLogout}
            />
          )}
        </main>
      )}

      {section === 'people' && (
        <main className="section-host">
          <PeopleSection
            currentUserId={currentUserId}
            existingContactIds={users.map(u => u.id)}
            onlineUserIds={onlineUsers}
            onOpenChat={handleStartChat}
            onOpenUserInfo={(userId) => setInfoModalUserId(userId)}
          />
        </main>
      )}

      {!isChats && section !== 'settings' && section !== 'people' && (
        <main className="section-host">
          <SectionStub section={activeSection} onBack={() => setSection('chats')} />
        </main>
      )}

      {isChats && (
        <main className="conversation">
          <div className="conv-head">
            <button type="button" className="icon-btn back-btn" onClick={() => setMobileView('list')} aria-label="Назад к списку">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
            </button>

            {activeChatMeta ? (
              <button
                type="button"
                className="conv-head-identity"
                onClick={() => activeChatMeta.userId && setInfoModalUserId(activeChatMeta.userId)}
                disabled={!activeChatMeta.userId}
              >
                <Avatar
                  name={activeChatMeta.name}
                  avatarPath={activeChatMeta.avatarPath}
                  size="sm"
                  isGeneral={activeChatMeta.section === 'general'}
                />
                <div className="conv-title">
                  <div className="name">{activeChatMeta.name}</div>
                  {/* «печатает…» вытесняет статус в самой шапке — так это
                      показывает Telegram, и индикатор виден, даже когда
                      переписка прокручена не до конца. */}
                  {typingText ? (
                    <div className="status is-typing">
                      {activeChatMeta.section === 'general' ? `${typingText} печатает` : 'печатает'}
                      <span className="typing-dots"><span /><span /><span /></span>
                    </div>
                  ) : (
                    <div className={'status' + (activeChatMeta.section === 'general' ? ' is-broadcast' : (activeChatMeta.online ? '' : ' is-offline'))}>
                      {activeChatMeta.section === 'general' ? 'рассылка на всех сотрудников' : (activeChatMeta.online ? 'в сети' : 'не в сети')}
                    </div>
                  )}
                </div>
              </button>
            ) : (
              <div className="conv-title"><div className="name">Выберите чат</div></div>
            )}
          </div>

          <ChatWindow
            chatId={activeChat}
            messages={messages}
            currentUserId={currentUserId}
            showAuthors={activeChat === GENERAL_CHAT_ID}
            onScrollTop={loadMoreMessages}
            hasMore={hasMore}
            loadingMore={loadingMore}
            unreadCount={activeChat ? unreadCounts[activeChat] : 0}
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
            placeholder={muted ? 'Отправка сообщений ограничена' : undefined}
          />
        </main>
      )}
    </div>
  );
};

export default Chat;
