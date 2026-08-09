import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { App as CapApp } from '@capacitor/app';
import ChatList, { Chat as RosterChat, ChatSection } from '../components/ChatList';
import ChatWindow from '../components/ChatWindow';
import MessageInput, { EditingMessage, PendingImage, ReplyingMessage } from '../components/MessageInput';
import ForwardModal, { ForwardPreviewItem, ForwardTarget } from '../components/ForwardModal';
import DeleteMessagesModal, { DeleteRequest } from '../components/DeleteMessagesModal';
import { MessageReaction } from '../components/ReactionDetailsModal';
import SettingsPanel from '../components/SettingsPanel';
import ProfileEdit from '../components/ProfileEdit';
import DirectoryModal from '../components/DirectoryModal';
import UserInfoModal from '../components/UserInfoModal';
import CreateGroupModal, { CreatedGroup } from '../components/CreateGroupModal';
import GroupInfoModal from '../components/GroupInfoModal';
import Avatar from '../components/Avatar';
import NavRail, { SectionId, isSectionAllowedFor, sectionById } from '../components/NavRail';
import SectionStub from '../components/SectionStub';
import TasksPanel from '../tasks/TasksPanel';
import CalendarSection from '../components/CalendarSection';
import PeopleSection from '../components/PeopleSection';
import NotificationStack, { ToastNotification } from '../components/NotificationStack';
import api from '../api/client';
import { nameFor } from '../utils/user';
import { renderUnreadBadge } from '../utils/badgeIcon';
import { describeStatus } from '../utils/statusMeta';
import { WritePolicy, WRITE_BLOCKED_HINT } from '../utils/writePolicy';
import StatusSheet from '../components/StatusSheet';
import { CustomEmojiMap, buildEmojiMap, toPlainText } from '../utils/customEmoji';
import { invalidateEmojiPackCache } from '../components/EmojiPicker';
import {
  ensureMobileNotificationPermission,
  showMobileNotification,
  isNativeMobile,
  dismissMobileNotifications,
  dismissAllMobileNotifications,
  onMobileNotificationTap
} from '../utils/mobileNotify';
import { initMobilePush, unregisterMobilePush, dismissAllPushNotifications } from '../utils/mobilePush';
import { closeMobileInputSurface, watchMobileKeyboard, hideMobileKeyboard } from '../utils/mobileKeyboard';
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
import {
  DEFAULT_UI_PREFS,
  ROSTER_MAX_WIDTH,
  ROSTER_MIN_WIDTH,
  UiPrefs,
  getUiPrefs,
  onUiPrefsChanged,
  saveUiPrefs
} from '../utils/uiPrefs';

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
  status_preset?: string | null;
  status_custom?: string | null;
}
interface Message {
  id: number;
  chat_id?: string;
  text: string;
  file_path?: string | null;
  file_width?: number | null;
  file_height?: number | null;
  sender_id: number;
  username: string;
  display_name?: string | null;
  created_at: string;
  status?: 'sent' | 'delivered' | 'read';
  /** Личная отметка о прочтении — единственный достоверный признак в общих чатах. */
  read_by_me?: number | boolean;
  edited_at?: string | null;
  deleted?: boolean | number;
  /** Сколько человек прочитало — только в каналах-объявлениях. */
  read_count?: number;
  reactions?: MessageReaction[];
}
interface LastMessage {
  chat_id: string;
  text: string;
  file_path?: string | null;
  created_at: string;
}

/** Превью текста сообщения там, где картинка без подписи не даёт ничего показать. */
// Текст для уведомлений — и всплывающих, и системных. Картинку там не
// показать, поэтому вместо кода подставляется базовый юникодный эмодзи
// смайлика: в шторке ОС `:cat:` читался бы как мусор.
function previewText(text: string, filePath?: string | null, emojiMap: CustomEmojiMap = {}): string {
  const plain = toPlainText(text || '', emojiMap);
  if (plain) return plain;
  return filePath ? '📷 Фото' : '';
}
interface ChatGroupSummary {
  id: number;
  chat_id: string;
  name: string;
  created_by: number;
  created_at: number;
  member_count: number;
  role: 'owner' | 'member';
  announcements_only: boolean;
  write_policy: WritePolicy;
  write_user_ids: number[];
  write_department_ids: number[];
  /** Считает сервер под конкретного зрителя — клиент эту логику не повторяет. */
  can_post?: boolean;
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
  statusPreset?: string | null;
  statusCustom?: string | null;
}

// Справочник сотрудников (не только контактов) — тем же набором полей, что и
// /contacts, начиная с сервера. Нужен только для одной вещи: чтобы окно
// профиля открывалось и для человека, которого ещё не добавили в контакты
// (в «Люди» аватар кликабелен для всех, не только для уже добавленных).
interface DirectoryUser {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  bio: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  birth_date: string | null;
  group_name: string | null;
}

const GENERAL_CHAT_ID = 'general';

// Синтетический "чат" для уведомлений о задачах: тосты и системные уведомления
// группируются по chatId, а у задачи переписки нет. Префикс с двоеточием не
// может совпасть ни с одним настоящим chat_id.
const TASKS_TOAST_ID = 'section:tasks';

// Общий чат и группы: у сообщения несколько получателей, поэтому «прочитано»
// там считается по личным отметкам (message_reads на сервере, read_by_me в
// ответе истории), а не по общей колонке status. Ровно та же граница, что и в
// server/services/readReceipts.js.
function isSharedChat(chatId: string | null): boolean {
  return !!chatId && (chatId === GENERAL_CHAT_ID || /^group_\d+$/.test(chatId));
}

// Экран целиком: раздел рельса, открыта ли поверх списка сама переписка (это
// имеет смысл только на узком экране) и подэкран внутри «Настроек».
interface ChatView {
  section: SectionId;
  conversation: boolean;
  settings: 'settings' | 'profile';
}

// Два готовых экрана-константы: открытая переписка и список чатов. Вынесены
// сюда, чтобы ни одно место не собирало состояние по кусочкам и не могло
// открыть чат, забыв про раздел (или наоборот).
const VIEW_CONVERSATION: ChatView = { section: 'chats', conversation: true, settings: 'settings' };
const VIEW_CHAT_LIST: ChatView = { section: 'chats', conversation: false, settings: 'settings' };

// Сколько держать анимацию панелей выключенной после закрытия клавиатуры —
// чуть дольше самого перехода (.3s), чтобы захватить и перестроение WebView.
const PANE_ANIM_SKIP_MS = 400;

// Порог узкого экрана. Должен совпадать с @media (max-width: 760px) в theme.css.
const NARROW_LAYOUT_QUERY = '(max-width: 760px)';

/**
 * Узкий экран (телефон) — здесь панели не соседствуют, а заменяют друг друга.
 *
 * Раскладка нужна именно в JS, а не только в CSS: на телефоне список чатов и
 * переписка должны существовать по очереди, а не одновременно. Раньше обе
 * панели были в DOM всегда, а переписка пряталась `transform: translateX(100%)`
 * — и стоило этому трансформу не примениться (композитор WebView роняет слой
 * при перестроении под клавиатуру, при возврате из фона, при оборванном
 * переходе), как переписка оставалась поверх списка. Экран выглядел как
 * открытый чат, а состояние при этом уже было «список»: кнопка «назад» вела
 * туда, где мы и так находимся, рельс — в раздел, который уже открыт, и выйти
 * было нечем. Ровно это и называлось «чат-ловушкой».
 */
function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_LAYOUT_QUERY).matches
  );

  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    // resize вдобавок к change у самого media query: событие change приходит
    // не во всех WebView (и не при программном изменении размера), а промах
    // здесь означает, что на телефоне в DOM окажутся сразу обе панели — то
    // самое состояние, из-за которого экран и запирался.
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return narrow;
}

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
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<number[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [lastMessages, setLastMessages] = useState<Record<string, LastMessage>>({});
  const [recentChatIds, setRecentChatIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  // Счётчики непрочитанного перезапрашиваются в нескольких местах разом
  // (подключение сокета, эхо своего же прочтения на других вкладках,
  // возврат приложения из фона) — несколько таких запросов могут улететь
  // почти одновременно, а вернуться в другом порядке из-за сетевой
  // задержки. Без защиты от переупорядочивания более старый (уже
  // неактуальный) ответ мог прилететь последним и откатить уже
  // очищенный бейдж обратно — ровно то, что выглядело как "отметка о
  // непрочитанном возвращается" при переключении между чатами.
  const unreadFetchSeq = useRef(0);
  const refetchUnread = useCallback((zeroChatId?: string) => {
    const seq = ++unreadFetchSeq.current;
    api.get('/unread')
      .then(({ data }) => {
        if (seq !== unreadFetchSeq.current) return;
        // Только что открытый чат гасим сразу: сервер в этот момент ещё
        // считает его непрочитанным (отметка уходит отдельным событием чуть
        // позже), и без этого бейдж успевал моргнуть обратно.
        setUnreadCounts(zeroChatId ? { ...data, [zeroChatId]: 0 } : data);
      })
      .catch(console.error);
  }, []);
  // Счётчик «задачи изменились»: сервер шлёт tasks_changed, панель задач по
  // изменению этого числа перечитывает список.
  const [tasksChangeToken, setTasksChangeToken] = useState(0);

  const applyRecentChats = useCallback((data: unknown) => {
    if (!Array.isArray(data)) return;
    setRecentChatIds(data
      .map(item => (item && typeof item === 'object' ? (item as { chat_id?: unknown }).chat_id : null))
      .filter((chatId): chatId is string => typeof chatId === 'string')
      .slice(0, 8));
  }, []);

  const recordRecentOpening = useCallback((chatId: string) => {
    if (!chatId || chatId === GENERAL_CHAT_ID) return;
    // Уже известный допустимый чат поднимаем без ожидания сети — ярлык не
    // должен заметно переставляться спустя RTT после клика. Новый чат всё
    // равно добавит только сервер, когда подтвердит наличие исходящих.
    setRecentChatIds(prev => prev.includes(chatId)
      ? [chatId, ...prev.filter(id => id !== chatId)].slice(0, 8)
      : prev);
    api.post(`/messages/meta/recent/${encodeURIComponent(chatId)}`)
      .then(({ data }) => applyRecentChats(data))
      .catch(console.error);
  }, [applyRecentChats]);
  // Текст сообщения, из которого заводят задачу («Создать задачу» в меню
  // сообщения) — уезжает в TasksPanel вместе с переходом в раздел.
  const [taskDraftText, setTaskDraftText] = useState<string | null>(null);
  // Сообщение, на которое отвечаем — панель над полем ввода, как при правке.
  const [replyingMessage, setReplyingMessage] = useState<ReplyingMessage | null>(null);
  // Сообщения, выбранные для пересылки — открывают выбор чата-получателя.
  const [forwardIds, setForwardIds] = useState<number[] | null>(null);
  // Запрос на удаление — открывает диалог с выбором области действия.
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  // Правка сообщения живёт здесь, а не в ленте: текст уезжает в поле ввода
  // (как в Telegram), а поле ввода — сосед ленты, общий родитель у них тут.
  const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [comments, setComments] = useState<Record<number, { username: string; display_name: string | null; comment: string }>>({});
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Навигация — ОДИН стейт, а не три независимых.
  //
  // Раньше раздел (section), открытость переписки на узком экране (mobileView) и
  // подэкран настроек (settingsView) жили порознь, и каждый переход обязан был
  // вручную привести в порядок остальные. Стоило одному месту забыть сбросить
  // mobileView — и раздел «Чаты» открывался сразу в последней переписке, где
  // рельс разделов скрыт и выйти уже некуда. Так уже ломались кнопки «назад» в
  // настройках, календаре и заглушках разделов; чинили их по одной, а место для
  // следующей такой ошибки оставалось.
  //
  // Теперь состояние экрана меняется только целиком, поэтому «переписка
  // открыта» физически не может пережить смену раздела.
  const [view, setView] = useState<ChatView>({ section: 'chats', conversation: false, settings: 'settings' });
  const { section } = view;
  // Ещё один пояс: даже если переписка каким-то образом окажется помеченной
  // открытой вне раздела «Чаты», показывать её мы не станем.
  const conversationOpen = view.section === 'chats' && view.conversation;
  const narrowLayout = useNarrowLayout();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [infoModalUserId, setInfoModalUserId] = useState<number | null>(null);
  const [chatGroups, setChatGroups] = useState<ChatGroupSummary[]>([]);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupInfoId, setGroupInfoId] = useState<number | null>(null);
  // Свой профиль — модальное окно поверх любого раздела, а не подэкран
  // настроек: он открывается по аватару с рельса, откуда бы ни нажали, и
  // возвращать после него в настройки (где человек не был) неправильно.
  const [profileOpen, setProfileOpen] = useState(false);
  // Справочник «Люди» — тоже окно поверх экрана, не отдельный раздел.
  const [peopleOpen, setPeopleOpen] = useState(false);
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
  const conversationVisible = windowFocused && conversationOpen;

  const currentUserId = Number(localStorage.getItem('userId'));

  // Живой снимок состояния для обработчика сокета — см. подробности там же.
  const liveRef = useRef({
    activeChat: null as string | null,
    allUsers: [] as AllUser[],
    chatGroups: [] as ChatGroupSummary[],
    windowFocused: true,
    conversationVisible: false,
    prefs: notificationPrefs,
    // Каталог смайликов нужен обработчику входящих, а он живёт с рендера,
    // на котором подписался, — читаем актуальный через ref, как и остальное.
    customEmoji: {} as CustomEmojiMap,
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
  // Тип "Интернет" — самостоятельная регистрация с улицы, не сотрудник: видит
  // урезанный рельс разделов (см. NavRail) и общий календарь ему не показывает
  // уже сам сервер.
  const [currentAccountType, setCurrentAccountType] = useState(localStorage.getItem('accountType') || 'staff');
  // Личный чат «для себя»: id зашит в свой же user id, название задаёт панель
  // управления (одно на всех). До первого ответа /users/me берём из
  // localStorage — иначе при запуске он моргал бы дефолтным названием.
  const [selfChatId, setSelfChatId] = useState(localStorage.getItem('selfChatId') || '');
  const [selfChatName, setSelfChatName] = useState(localStorage.getItem('selfChatName') || 'Избранное');
  // Базовые реакции задаются в панели управления и приезжают вместе с профилем.
  const [reactionEmoji, setReactionEmoji] = useState<string[]>([]);

  // Каталог кастомных смайликов нужен всюду, где показывается текст сообщения,
  // а не только в панели выбора. И это НЕ то же самое, что содержимое панели:
  // /emoji отдаёт «что можно вставить сейчас», а /emoji/catalog — всё, что
  // когда-либо существовало, включая убранное и выключенное. Иначе уборка
  // смайлика переводила бы всю старую переписку обратно в текст :name:.
  const [customEmoji, setCustomEmoji] = useState<CustomEmojiMap>({});
  const reloadEmojiCatalog = useCallback(() => {
    api.get('/emoji/catalog')
      .then(({ data }) => setCustomEmoji(buildEmojiMap(data)))
      .catch(() => { /* без каталога коды останутся текстом — не фатально */ });
  }, []);
  useEffect(() => { reloadEmojiCatalog(); }, [reloadEmojiCatalog]);
  const [statusSheetOpen, setStatusSheetOpen] = useState(false);
  const [currentStatusPreset, setCurrentStatusPreset] = useState<string | null>(localStorage.getItem('statusPreset') || null);
  const [currentStatusCustom, setCurrentStatusCustom] = useState<string | null>(localStorage.getItem('statusCustom') || null);
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

  // То же самое для настроек интерфейса (группировка контактов, ширина списка).
  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(getUiPrefs);
  useEffect(() => onUiPrefsChanged(setUiPrefs), []);

  // Растягивание списка чатов мышью. Ширина во время перетаскивания живёт в
  // состоянии (перерисовка на каждый кадр), а в localStorage уходит один раз,
  // на отпускании: писать туда на каждое движение мыши незачем.
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeStateRef.current = { startX: e.clientX, startWidth: uiPrefs.rosterWidth };
  };

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state) return;
    const next = Math.min(
      ROSTER_MAX_WIDTH,
      Math.max(ROSTER_MIN_WIDTH, state.startWidth + (e.clientX - state.startX))
    );
    setUiPrefs((prev) => (prev.rosterWidth === next ? prev : { ...prev, rosterWidth: next }));
  };

  const handleResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStateRef.current) return;
    resizeStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // saveUiPrefs разошлёт событие — свой же слушатель просто перезапишет
    // состояние тем же значением, это дешевле, чем городить исключение.
    saveUiPrefs(getUiPrefsSnapshot());
  };

  // Актуальные настройки на момент отпускания мыши — из ref, а не из замыкания
  // обработчика, которое могло быть создано с шириной от начала перетаскивания.
  const uiPrefsRef = useRef(uiPrefs);
  uiPrefsRef.current = uiPrefs;
  function getUiPrefsSnapshot() { return uiPrefsRef.current; }

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

    // На нативном Android document.hasFocus()/visibilitychange — это события
    // WebView, а не приложения: они не всегда срабатывают, когда приложение
    // сворачивают кнопкой "Домой" или уходят в переключатель задач, из-за чего
    // windowFocused иногда застревал в "true", пока приложение реально было
    // в фоне — и системное уведомление тогда не показывалось вовсе (см.
    // ветку showMobileNotification ниже, она условие на !focused). appStateChange
    // — собственное событие жизненного цикла Capacitor, ему можно доверять.
    let unsubscribeCapacitor: (() => void) | undefined;
    if (isNativeMobile) {
      const listenerPromise = CapApp.addListener('appStateChange', ({ isActive }) => setWindowFocused(isActive));
      unsubscribeCapacitor = () => { listenerPromise.then((h) => h.remove()); };
    }

    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      unsubscribeElectron?.();
      unsubscribeCapacitor?.();
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
    // Картинку оверлея рисуем здесь: в main-процессе нечем (см. badgeIcon.ts).
    window.electronAPI?.setUnreadBadge(totalUnread, renderUnreadBadge(totalUnread) || undefined);
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
  // замороженным состоянием: она видела «переписка закрыта» при открытом
  // чате и сворачивала приложение вместо возврата к списку. Разворачиваешь —
  // тот же открытый чат, "назад" снова сворачивает, и так до полного
  // закрытия приложения.
  const backNavRef = useRef({ view, directoryOpen, infoModalUserId, createGroupOpen, groupInfoId, profileOpen, peopleOpen });
  backNavRef.current = { view, directoryOpen, infoModalUserId, createGroupOpen, groupInfoId, profileOpen, peopleOpen };

  useEffect(() => watchMobileKeyboard(), []);

  // Уход с экрана переписки и переход между разделами — синхронные и
  // безусловные. Клавиатуре просто отдаём команду закрыться в том же кадре.
  //
  // Раньше и то и другое переключало экран только внутри
  // hideMobileKeyboard().then(...) — ждали, пока WebView перестроится под
  // уезжающую клавиатуру, чтобы не рвать CSS-переход. Цена оказалась
  // несопоставимой: промис ходил в нативный мост, а .catch() у него не было, и
  // единственный отказ моста навсегда убивал сразу все способы уйти с открытой
  // переписки — включая аппаратную «назад», которая зовёт этот же
  // leaveConversation. Рельс разделов в переписке скрыт, так что выйти
  // становилось нечем: помогал только перезапуск приложения.
  //
  // Испорченная анимация — косметика, запертый экран — блокер, поэтому
  // навигация больше не зависит от ответа нативной части ничем. Сама проблема
  // с анимацией решается иначе: если клавиатура была открыта, переход между
  // панелями просто проходит без анимации — рвать нечего.
  const [skipPaneAnim, setSkipPaneAnim] = useState(false);
  const paneAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeKeyboard = useCallback(() => {
    // Общая поверхность включает два взаимоисключающих режима. При уходе со страницы закрываем
    // её целиком: в режиме emoji одной команды системной клавиатуре недостаточно.
    const surfaceWasOpen = closeMobileInputSurface();
    const keyboardWasOpen = surfaceWasOpen ? false : hideMobileKeyboard();
    if (!surfaceWasOpen && !keyboardWasOpen) return;
    setSkipPaneAnim(true);
    if (paneAnimTimer.current) clearTimeout(paneAnimTimer.current);
    paneAnimTimer.current = setTimeout(() => setSkipPaneAnim(false), PANE_ANIM_SKIP_MS);
  }, []);

  useEffect(() => () => { if (paneAnimTimer.current) clearTimeout(paneAnimTimer.current); }, []);

  const leaveConversation = useCallback(() => {
    closeKeyboard();
    setView(VIEW_CHAT_LIST);
  }, [closeKeyboard]);

  const goToSection = useCallback((id: SectionId) => {
    closeKeyboard();
    // Раздел всегда открывается «сначала»: «Чаты» — списком, а не последней
    // перепиской, «Настройки» — списком настроек, а не подэкраном профиля, на
    // котором человек был в прошлый раз.
    setView({ section: id, conversation: false, settings: 'settings' });
  }, [closeKeyboard]);

  // Подписка на сокет живёт столько же, сколько сам сокет, а goToSection
  // пересоздаётся — держим актуальную версию в ref, как и handleSelectChat.
  const goToSectionRef = useRef(goToSection);
  goToSectionRef.current = goToSection;

  // Тип аккаунта сменили, пока человек сидит в разделе, которого у него больше
  // нет (задачи, документы, пространства) — уводим в чаты. Эффектом, а не в
  // обработчике сокета: сюда же попадает случай, когда тип из localStorage
  // разошёлся с настоящим и правда приезжает первым же ответом /users/me.
  useEffect(() => {
    if (!isSectionAllowedFor(currentAccountType, section)) goToSection('chats');
  }, [currentAccountType, section, goToSection]);

  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('backButton', () => {
      const nav = backNavRef.current;
      // Emoji-панель — часть той же нижней конструкции, что и IME. Когда IME
      // нет и Android отдаёт Back приложению, сначала закрываем конструкцию,
      // а уже следующим нажатием выполняем навигацию.
      if (closeMobileInputSurface()) return;
      // Модалки поверх всего — закрываются первыми, иначе "назад" уводил
      // экран из-под открытого окна, а само окно оставалось висеть.
      if (nav.groupInfoId !== null) { setGroupInfoId(null); return; }
      if (nav.createGroupOpen) { setCreateGroupOpen(false); return; }
      if (nav.infoModalUserId !== null) { setInfoModalUserId(null); return; }
      if (nav.directoryOpen) { setDirectoryOpen(false); return; }
      if (nav.profileOpen) { setProfileOpen(false); return; }
      if (nav.peopleOpen) { setPeopleOpen(false); return; }
      // Тот же сброс, что и в goToSection: аппаратная кнопка «назад» возвращает
      // к списку чатов, а не в переписку, открытую до ухода в другой раздел.
      if (nav.view.section !== 'chats') { setView(VIEW_CHAT_LIST); return; }
      if (nav.view.conversation) { leaveConversation(); return; }
      // Со списка чатов — сворачиваем, а не убиваем процесс.
      CapApp.minimizeApp();
    });
    return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
  }, [leaveConversation]);

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
        setCurrentAccountType(data.account_type || 'staff');
        setCurrentStatusPreset(data.status_preset || null);
        setCurrentStatusCustom(data.status_custom || null);
        setSelfChatId(data.self_chat_id || '');
        setSelfChatName(data.self_chat_name || 'Избранное');
        setReactionEmoji(Array.isArray(data.reaction_emoji) ? data.reaction_emoji : []);
        localStorage.setItem('selfChatId', data.self_chat_id || '');
        localStorage.setItem('selfChatName', data.self_chat_name || 'Избранное');
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
        localStorage.setItem('accountType', data.account_type || 'staff');
        localStorage.setItem('statusPreset', data.status_preset || '');
        localStorage.setItem('statusCustom', data.status_custom || '');
      }).catch(console.error);

      api.get('/contacts').then(({ data }) => setUsers(data)).catch(console.error);
      refetchUnread();
      api.get('/favorites').then(({ data }) => setFavorites(data)).catch(console.error);
      api.get('/comments').then(({ data }) => setComments(data)).catch(console.error);
      api.get('/messages/meta/last').then(({ data }) => setLastMessages(data)).catch(console.error);
      api.get('/messages/meta/recent').then(({ data }) => applyRecentChats(data)).catch(console.error);
      api.get('/groups').then(({ data }) => setChatGroups(data)).catch(console.error);
      // Только для профиля людей, ещё не добавленных в контакты — см.
      // DirectoryUser выше и infoModalUser ниже.
      api.get('/users').then(({ data }) => setDirectory(data)).catch(console.error);

      // Каталог кастомных смайликов раньше тянулся только один раз при
      // монтировании — если пак создали УЖЕ ПОСЛЕ этого, или самый первый
      // запрос не успел выполниться (сокет/токен ещё не были готовы), код
      // :name: молча оставался текстом до перезапуска приложения: только
      // полное монтирование запрашивало каталог заново. Реконнект случается
      // регулярно и без участия человека (сворачивание на Android,
      // кратковременный обрыв сети) — обновляем заодно с остальным.
      reloadEmojiCatalog();
      invalidateEmojiPackCache();
    });

    // Правка смайликов в панели управления доходит до всех сразу, а не на
    // следующем реконнекте: каталог общий, персонализации в нём нет.
    newSocket.on('emoji_changed', () => {
      reloadEmojiCatalog();
      // Панель выбора держит свой кэш и перечитывает его при открытии — без
      // сброса она показала бы старый состав, пока её не откроют дважды.
      invalidateEmojiPackCache();
    });

    // Открытие или первая успешная отправка на другом устройстве сразу
    // перестраивает ту же ленту здесь — порядок недавних общий для аккаунта.
    newSocket.on('recent_chats_changed', applyRecentChats);

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
    newSocket.on('message_status_bulk', (data: {
      chatId: string; messageIds: number[]; status: 'read';
      /** Только для каналов-объявлений — сколько человек прочитало. */
      readCounts?: Record<number, number>;
    }) => {
      setMessages(prev => prev.map(m => {
        if (!data.messageIds.includes(m.id)) return m;
        const readCount = data.readCounts?.[m.id];
        return readCount === undefined
          ? { ...m, status: data.status }
          : { ...m, status: data.status, read_count: readCount };
      }));

      if (data.status === 'read') {
        refetchUnread();
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

    // Реакции меняются часто и мелко — сервер шлёт готовый список по одному
    // сообщению, клиент просто подставляет его вместо прежнего.
    newSocket.on('reactions_changed', (data: { chat_id: string; message_id: number; reactions: MessageReaction[] }) => {
      setMessages(prev => prev.map(m => (m.id === data.message_id ? { ...m, reactions: data.reactions } : m)));
    });

    // «Удалить только у себя»: сообщение остаётся у всех остальных, поэтому
    // событие приходит только в свою же комнату. Убираем его из ленты совсем —
    // в отличие от deleted, где строка ещё живёт со снятым содержимым.
    newSocket.on('message_hidden', (data: { id: number; chat_id: string }) => {
      setMessages(prev => prev.filter(m => m.id !== data.id));
      api.get('/messages/meta/last').then(({ data: last }) => setLastMessages(last)).catch(console.error);
      refetchUnread();
    });

    // Прав убрать у всех не хватило — сервер отказал. Сообщаем честно, вместо
    // того чтобы молча оставить сообщение на месте.
    newSocket.on('message_delete_denied', () => {
      pushToast({
        chatId: 'delete-denied',
        title: 'Не удалось удалить',
        body: 'Убрать чужое сообщение у всех может владелец группы или администрация.',
        avatarPath: null,
      });
    });

    // Массовое удаление создателем группы — тот же эффект, что и одиночное
    // message_deleted, но сразу на список id.
    newSocket.on('messages_deleted', (data: { chat_id: string; ids: number[] }) => {
      setMessages(prev => prev.map(m => data.ids.includes(m.id) ? { ...m, deleted: true, text: '' } : m));
      api.get('/messages/meta/last').then(({ data: last }) => setLastMessages(last)).catch(console.error);
    });

    // Задачи. tasks_changed — сигнал перечитать список (кто-то из причастных
    // сменил статус или правил задачу), task_notification — то, ради чего
    // человека стоит отвлечь. Раньше сервер слал оба события, но слушать их
    // на клиенте было некому: уведомлений по задачам не приходило вовсе, а
    // чужие изменения появлялись только после переключения вкладки.
    newSocket.on('tasks_changed', () => setTasksChangeToken(t => t + 1));

    newSocket.on('task_notification', (data: { type: string; taskId: number; title: string; body: string }) => {
      setTasksChangeToken(t => t + 1);

      const { windowFocused: focused, prefs } = liveRef.current;
      if (!prefs.enabled) return;

      if (prefs.sound && (!isNativeMobile || focused)) playIncomingSound();

      // Чат задачи — синтетический: тост и системное уведомление группируются
      // по нему, а тап ведёт в раздел «Задачи», а не в переписку.
      pushToast({ chatId: TASKS_TOAST_ID, title: data.title, body: data.body, avatarPath: null });

      if (!focused) {
        if (isNativeMobile) {
          showMobileNotification(data.taskId, `MirasChat — ${data.title}`, data.body, TASKS_TOAST_ID);
        } else if (prefs.system) {
          showDesktopNotification({
            title: data.title,
            body: data.body,
            tag: TASKS_TOAST_ID,
            onClick: () => {
              window.electronAPI?.focusWindow?.();
              window.focus();
              goToSectionRef.current('tasks');
            },
          });
        }
      }
    });

    // Группу создали (нас позвали), переименовали/добавили-убрали участника,
    // или её больше нет — синхронизируем список чатов живьём, без опроса.
    newSocket.on('group_created', (group: ChatGroupSummary) => {
      setChatGroups(prev => prev.some(g => g.id === group.id) ? prev : [...prev, group]);
    });
    newSocket.on('group_updated', (group: ChatGroupSummary) => {
      setChatGroups(prev => prev.map(g => g.id === group.id ? { ...g, ...group } : g));
      // can_post считается под конкретного зрителя, а это событие одно на всех
      // участников — в нём его нет. После смены прав перечитываем список, иначе
      // у человека остался бы composer от прежней политики.
      api.get('/groups').then(({ data }) => setChatGroups(data)).catch(console.error);
    });
    newSocket.on('group_removed', (data: { id: number; chat_id: string }) => {
      setChatGroups(prev => prev.filter(g => g.id !== data.id));
      // Читаем текущий чат из liveRef, а не вызываем setView внутри updater'а
      // setActiveChat: обновляющая функция обязана быть чистой, а в StrictMode
      // React выполняет её дважды.
      if (liveRef.current.activeChat === data.chat_id) {
        setActiveChat(null);
        setView(VIEW_CHAT_LIST);
      }
    });

    // Супер-админ (или теперь и обычный "Администратор" из профиля) может
    // включить/выключить режим тишины или сменить роль/группу/тип прямо во
    // время сессии — применяем сразу, без перелогина. Это всегда про самого
    // себя: сервер шлёт это только в комнату 'user:<id>' затронутого.
    newSocket.on('account_updated', (data: { muted?: boolean; role?: string | null; account_type?: string }) => {
      if (typeof data.muted === 'boolean') {
        setMuted(data.muted);
        localStorage.setItem('muted', String(data.muted));
      }
      if (data.role !== undefined) {
        setCurrentUserRole(data.role);
        localStorage.setItem('role', data.role || '');
      }
      // Тип аккаунта решает, какие разделы вообще видны (см. NavRail). Сервер
      // слал его и раньше, но клиент читал только muted/role — смена типа
      // доезжала лишь после перелогина. Уводом из закрывшегося раздела
      // занимается отдельный эффект ниже, не этот обработчик.
      if (data.account_type !== undefined) {
        setCurrentAccountType(data.account_type || 'staff');
        localStorage.setItem('accountType', data.account_type || 'staff');
      }
    });

    // На случай если состояние тишины ещё не долетело (например, включили в
    // другой вкладке) — сервер всё равно не даст отправить, страхуем и тут.
    newSocket.on('message_blocked', (data: { reason?: string }) => {
      if (data.reason === 'muted') {
        setMuted(true);
        localStorage.setItem('muted', 'true');
      }
      // 'announcement_only' отдельного действия не требует: композер и так
      // задизейблен по activeChatMeta.canPostHere — это подстраховка на случай
      // рассинхрона (роль сменили в другой вкладке), сама композиция уже скрыта.
    });

    return () => {
      Object.values(expiryTimers).forEach(clearTimeout);
      clearInterval(rosterRefreshInterval);
      newSocket.disconnect();
    };
  }, [currentUserId, refetchUnread, pushToast, reloadEmojiCatalog, applyRecentChats]);

  // Возврат приложения из фона на Android — пока оно свёрнуто, ОС может
  // оборвать сеть (Doze/App Standby), и сокет повиснет отключённым: его
  // встроенный реконнект теоретически должен сработать сам, но ждать его
  // внутренний backoff не нужно — сразу форсируем попытку и на всякий случай
  // подтягиваем то, что могло не долететь, пока соединение было мертво.
  //
  // Подписываемся один раз, а сокет и открытый чат читаем из ref — по той же
  // причине, что и в обработчике аппаратной «назад»: эффект с deps
  // [socket, activeChat] пересоздавал нативную подписку на каждое открытие
  // чата, а remove() уходит в мост асинхронно и может не успеть. Пережившая
  // отмену подписка помнила свой activeChat и при возврате из фона затирала
  // messages историей уже закрытого чата.
  const resumeRef = useRef<{ socket: Socket | null; activeChat: string | null }>({ socket: null, activeChat: null });
  resumeRef.current = { socket, activeChat };

  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('appStateChange', ({ isActive }) => {
      const { socket: liveSocket, activeChat: liveActiveChat } = resumeRef.current;

      // Сообщаем серверу, способны ли мы сейчас показать уведомление сами.
      // Пока он считал живой сокет достаточным признаком, свёрнутое
      // приложение не получало ни пуша (сервер думал «клиент покажет сам»),
      // ни локального уведомления (JS в свёрнутом WebView заморожен).
      liveSocket?.emit('app_state', { active: isActive });

      if (!isActive) return;

      if (liveSocket && !liveSocket.connected) {
        liveSocket.connect();
      }

      refetchUnread();

      if (liveActiveChat) {
        api.get(`/messages/${liveActiveChat}?limit=50&offset=0`)
          .then(({ data }) => {
            // Пока ответ шёл, человек мог уйти в другой чат — тогда эта история
            // уже чужая и применять её нельзя.
            if (resumeRef.current.activeChat !== liveActiveChat) return;
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
    return () => { listenerPromise.then((h) => h.remove()).catch(() => {}); };
  }, [refetchUnread]);

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
      const { activeChat: liveActiveChat, allUsers: liveUsers, chatGroups: liveGroups, windowFocused: focused, conversationVisible, prefs } = liveRef.current;
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
          [chatId]: { chat_id: chatId, text: message.text, file_path: message.file_path, created_at: message.created_at }
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
      const group = liveGroups.find(g => g.chat_id === chatId);
      // Групповой чат раньше сюда не заглядывал вовсе: otherUser не находился
      // (у группы нет "второго участника"), и уведомление показывало имя
      // отправителя как заголовок — неотличимо от личного сообщения, хотя
      // сообщение видят все в группе.
      const chatName = isGeneral ? 'Общий чат' : group ? group.name : (otherUser ? nameFor(otherUser) : nameFor(message));

      // В общем чате и в группах важно, кто именно написал — иначе все
      // уведомления выглядят одинаково и по ним не понять, стоит ли отвлекаться.
      const preview = previewText(message.text, message.file_path, liveRef.current.customEmoji);
      const body = (isGeneral || group) ? `${nameFor(message)}: ${preview}` : preview;

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
        isGeneral,
        isGroup: !!group
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

      refetchUnread(activeChat);

      return () => { cancelled = true; };
    } else {
      setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat]);

  // Смена чата отменяет начатую правку и ответ: и то и другое относилось к
  // прошлой переписке (ответить на сообщение из другого чата сервер и не даст).
  useEffect(() => {
    setEditingMessage(null);
    setReplyingMessage(null);
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

    // В общем чате и группах общий status значит «прочитано хоть кем-то» —
    // отбирать по нему непрочитанное нельзя: сообщение, которое открыл кто-то
    // другой, для меня осталось бы непрочитанным навсегда (сервер считает
    // непрочитанное по личным отметкам message_reads, а клиент такие id ему
    // просто не присылал). Отсюда и возвращающийся бейдж, который лечился
    // только кнопкой «Прочитать всё». Личная отметка — read_by_me.
    const shared = isSharedChat(activeChat);
    const unreadIds = messages
      .filter(m => m.sender_id !== currentUserId)
      .filter(m => (shared ? !m.read_by_me : m.status !== 'read'))
      .map(m => m.id);

    if (unreadIds.length > 0) {
      socket.emit('message_read', { chatId: activeChat, messageIds: unreadIds });
      // Помечаем локально сразу: иначе эффект, зависящий от messages, при
      // следующем сообщении снова собрал бы те же id и слал их по кругу.
      if (shared) {
        const justRead = new Set(unreadIds);
        setMessages(prev => prev.map(m => (justRead.has(m.id) ? { ...m, read_by_me: 1 } : m)));
      }
      dismissMobileNotifications(unreadIds);
      // Пуши приходят только когда сокет был мёртв, а раз мы сейчас читаем —
      // приложение открыто и сокет жив. Значит все висящие пуш-карточки уже
      // неактуальны: то, что осталось непрочитанным, видно в списке чатов.
      // Адресно их снять нельзя — плагин умеет только "все сразу".
      dismissAllPushNotifications();
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
    dismissAllPushNotifications();
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

  // Комментарии. Теперь редактируются из профиля (UserInfoModal), который
  // открывается и для людей, ещё не добавленных в контакты, — поэтому имя для
  // локального эха ищем не только среди contacts (allUsers), но и в
  // справочнике (directory), иначе для не-контакта комментарий уходил бы на
  // сервер, но не показался бы в списке чатов до следующей перезагрузки.
  const updateComment = async (targetUserId: number, comment: string) => {
    try {
      await api.post('/comments', { target_user_id: targetUserId, comment });
      const user = allUsers.find(u => u.id === targetUserId) || directory.find(u => u.id === targetUserId);
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
    statusPreset: u.status_preset,
    statusCustom: u.status_custom,
  }));

  // Обновляем снимок для обработчика сокета на каждом рендере — присваивание
  // должно идти после объявления allUsers, иначе получим TDZ.
  liveRef.current = { activeChat, allUsers, chatGroups, windowFocused, conversationVisible, prefs: notificationPrefs, customEmoji };

  const handleSelectChat = (chatId: string) => {
    // Сначала выясняем, знаем ли мы вообще такой чат. Раньше проверка стояла
    // только вокруг setActiveChat, а панель переключалась на переписку в любом
    // случае — и при неизвестном chat_id (тап по уведомлению от человека,
    // который ещё не подгрузился в список контактов) открывался ПРОШЛЫЙ чат:
    // activeChat оставался старым, а вид уже был перепиской.
    const known =
      chatId === GENERAL_CHAT_ID || (!!selfChatId && chatId === selfChatId)
        ? true
        : /^group_\d+$/.test(chatId)
          ? chatGroups.some(g => g.chat_id === chatId)
          : allUsers.some(u => u.source === 'local' && getChatId(u.id) === chatId);

    if (!known) {
      // Показываем список чатов: там нужный диалог появится, как только
      // доедет ростер, — это честнее, чем открыть чужую переписку.
      setView(VIEW_CHAT_LIST);
      return;
    }

    // Не даём ChatWindow ни одного кадра рисовать историю предыдущего
    // диалога уже с новым chatId. Иначе его initial-scroll может отработать
    // по старой геометрии, а настоящая история приедет чуть позже.
    if (chatId !== activeChat) {
      setMessages([]);
      setHasMore(true);
      loadingMoreRef.current = false;
    }
    setActiveChat(chatId);
    recordRecentOpening(chatId);
    closeKeyboard();
    // Открытые Настройки/Профиль/другой раздел иначе продолжали закрывать собой
    // область переписки — activeChat менялся, а видимая панель оставалась прежней.
    setView(VIEW_CONVERSATION);
  };

  // Тап по системному уведомлению на Android — открыть тот же чат, откуда
  // пришло сообщение. handleSelectChat пересоздаётся на каждый рендер, поэтому
  // держим актуальную версию в ref и подписываемся на нативное событие один раз.
  const handleSelectChatRef = useRef(handleSelectChat);
  handleSelectChatRef.current = handleSelectChat;

  // Тап по уведомлению: у задачи переписки нет, поэтому её карточка ведёт в
  // раздел, а не в чат.
  const openFromNotificationRef = useRef((chatId: string) => {
    if (chatId === TASKS_TOAST_ID) goToSectionRef.current('tasks');
    else handleSelectChatRef.current(chatId);
  });

  useEffect(() => {
    return onMobileNotificationTap((chatId) => {
      openFromNotificationRef.current(chatId);
    });
  }, []);

  // Пуш-уведомления: единственный канал, который переживает свёрнутое или
  // выгруженное приложение. Регистрируем токен при каждом запуске, а тап по
  // карточке из шторки ведёт в тот же чат, что и локальное уведомление.
  useEffect(() => {
    return initMobilePush((chatId) => {
      openFromNotificationRef.current(chatId);
    });
  }, []);

  const handleSendMessage = (text: string, image?: PendingImage) => {
    if (socket && activeChat) {
      socket.emit('chat_message', {
        chatId: activeChat,
        text,
        filePath: image?.file_path,
        fileWidth: image?.file_width,
        fileHeight: image?.file_height,
        replyToId: replyingMessage?.id,
      });
      socket.emit('stop_typing', { chatId: activeChat, userId: currentUserId });
      setReplyingMessage(null);
    }
  };

  // Пересылка: отправляем те же сообщения в выбранный чат с подписью «переслано
  // от». Копией, а не ссылкой — исходное могут удалить, а пересланное должно
  // остаться (и наоборот: правка исходного пересланное не трогает).
  const forwardTo = (ids: number[], targetChatId: string, openTarget = true) => {
    if (!socket) return;
    const sourceName = activeChatMeta?.name || '';

    // Порядок сохраняем по id: выделяли в произвольном порядке, а прийти
    // должно так же, как шло в переписке.
    const toSend = messages
      .filter((m) => ids.includes(m.id) && !m.deleted)
      .sort((a, b) => a.id - b.id);

    for (const msg of toSend) {
      socket.emit('chat_message', {
        chatId: targetChatId,
        text: msg.text,
        filePath: msg.file_path,
        fileWidth: msg.file_width,
        fileHeight: msg.file_height,
        forwardedFromName: nameFor(msg),
        forwardedFromChat: sourceName,
      });
    }

    setForwardIds(null);
    // В «Избранное» уходят, не отрываясь от переписки, — туда не переключаемся.
    if (openTarget) handleSelectChat(targetChatId);
    else pushToast({
      chatId: 'forwarded-to-self',
      title: selfChatName,
      body: toSend.length > 1 ? `Переслано сообщений: ${toSend.length}` : 'Сообщение переслано',
      avatarPath: null,
    });
  };

  const handleForward = (targetChatId: string) => {
    if (forwardIds) forwardTo(forwardIds, targetChatId);
  };

  // Начать чат с кем-то из справочника — контакт появляется в своём списке
  // сразу (без ожидания первого сообщения); у собеседника — только когда
  // сообщение реально отправлено (см. серверную автоподписку).
  const handleStartChat = async (user: { id: number; username: string; display_name: string | null; avatar_path: string | null; group_id: number | null; group_name: string | null }) => {
    setUsers(prev => prev.some(u => u.id === user.id) ? prev : [...prev, { ...user, bio: null, phone: null, department: null, position: null, birth_date: null }]);
    setDirectoryOpen(false);
    const chatId = getChatId(user.id);
    setActiveChat(chatId);
    recordRecentOpening(chatId);
    closeKeyboard();
    setView(VIEW_CONVERSATION);
    try {
      await api.post(`/contacts/${user.id}`);
    } catch (e) {
      console.error('Ошибка добавления контакта:', e);
    }
  };

  // Из раздела «Люди» — добавить в контакты без перехода в переписку, в
  // отличие от handleStartChat, который сразу открывает чат.
  const handleAddContact = async (user: { id: number; username: string; display_name: string | null; avatar_path: string | null; group_id: number | null; group_name: string | null }) => {
    setUsers(prev => prev.some(u => u.id === user.id) ? prev : [...prev, { ...user, bio: null, phone: null, department: null, position: null, birth_date: null }]);
    try {
      await api.post(`/contacts/${user.id}`);
    } catch (e) {
      console.error('Ошибка добавления контакта:', e);
    }
  };

  const handleRemoveContact = async (userId: number) => {
    if (activeChat === getChatId(userId)) {
      setActiveChat(null);
      setView(VIEW_CHAT_LIST);
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

  // Правка последнего своего сообщения по стрелке вверх — берём самое свежее
  // неудалённое своё сообщение в открытом чате.
  const requestEditLast = () => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.sender_id === currentUserId && !msg.deleted && msg.text) {
        setEditingMessage({ id: msg.id, text: msg.text });
        return;
      }
    }
  };

  // Удаление всегда идёт через диалог: у него есть область действия («только у
  // меня» / «у всех»), и выбрать её надо до отправки. Само удаление — в
  // performDelete, а тут только собираем запрос и решаем, что предложить.
  const requestDelete = (ids: number[]) => {
    if (!ids.length || !activeChatMeta) return;

    const mineOnly = ids.every((id) => {
      const msg = messages.find((m) => m.id === id);
      return !!msg && msg.sender_id === currentUserId;
    });

    // Право убрать у всех: своё — всегда; чужое — в личной переписке (там
    // собеседник один), а в группе и общем чате только владельцу группы или
    // администрации. Это зеркало серверной canDeleteForEveryone: клиент лишь
    // не предлагает того, что сервер всё равно отклонит.
    const isShared = activeChatMeta.section === 'group' || activeChatMeta.section === 'general';
    const isAdmin = currentUserRole === 'admin' || currentUserRole === 'moderator';
    const canDeleteForEveryone = mineOnly
      || (isShared ? (!!activeChatMeta.isGroupOwner || isAdmin) : true);

    setDeleteRequest({
      ids,
      partnerName: activeChatMeta.section === 'staff' ? activeChatMeta.name : null,
      canDeleteForEveryone,
      isGroup: isShared,
    });
  };

  const performDelete = (forEveryone: boolean) => {
    const request = deleteRequest;
    setDeleteRequest(null);
    if (!request || !socket) return;

    // Владелец/администрация в группе снимают чужие сообщения пачкой одной
    // REST-ручкой — сокет по одному сообщению за раз тут был бы десятком
    // круговых обходов. Всё остальное (в том числе «скрыть у себя») идёт
    // сокетом: там область действия передаётся флагом.
    const bulkInGroup = forEveryone && request.isGroup && activeChatMeta?.chatGroupId && request.ids.length > 1;
    if (bulkInGroup) {
      api.post(`/groups/${activeChatMeta!.chatGroupId}/messages/delete`, { ids: request.ids }).catch(console.error);
      return;
    }

    for (const id of request.ids) socket.emit('message_delete', { id, forEveryone });
  };

  // Реакции. Своё состояние не трогаем — ждём reactions_changed от сервера:
  // он приходит и себе тоже, а собирать список локально значило бы дублировать
  // правило «одна реакция на человека» ещё и на клиенте.
  const handleToggleReaction = (messageId: number, emoji: string) => {
    socket?.emit('reaction_set', { messageId, emoji });
  };

  const handleRemoveReaction = (messageId: number, userId: number) => {
    socket?.emit('reaction_remove', { messageId, userId });
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

  const handleLogout = async () => {
    // Уведомления от прошлого аккаунта не должны пережить выход — системные
    // карточки живут вне окна и с requireInteraction висят, пока их не закроют.
    dismissAllDesktopNotifications();
    dismissAllMobileNotifications();
    dismissAllPushNotifications();
    // Обязательно до localStorage.clear(): запрос требует токена авторизации.
    // Без него телефон остался бы подписан на пуши прежнего пользователя.
    await unregisterMobilePush();
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
    if (c.section === 'self') return -0.5;
    if (favorites.includes(c.id)) return 0;
    // Групповые чаты (созданные вручную, не отдел из панели супер-админа) —
    // отдельным блоком сразу после избранного, до отделов настоящих.
    if (c.section === 'group') return 0.5;
    // Без жёсткой группировки все люди в одном ранге — порядок между ними
    // решает свежесть переписки. Раньше разделы по группам были всегда, и
    // человек, которому только что написали, уезжал вниз, в свой раздел.
    if (!uiPrefs.groupContacts) return 1;
    // groupLabel у "безгруппных" — это плейсхолдер "Без группы", а не реальное
    // название группы. truthy-проверка тут не годится: indexOf вернёт -1,
    // и 2 + (-1) = 0 столкнёт их с избранными вместо конца списка.
    const idx = realGroupNames.indexOf(c.groupLabel || '');
    if (idx !== -1) return 1 + idx;
    return 1 + realGroupNames.length; // "Без группы" — всегда последними
  }

  // Формирование списка чатов: Общий чат — всегда первым, дальше избранные
  // (по свежести), затем свои групповые чаты, затем реальные группы
  // (настроены в панели супер-админа), внутри каждой — тоже по свежести.
  const allChats: RosterChat[] = [
    { id: GENERAL_CHAT_ID, name: 'Общий чат', section: 'general' as ChatSection, groupLabel: null as string | null },
    // Личный чат «для себя» — сразу за общим, до всех остальных: это заметки
    // и пересылки, к нему возвращаются часто, и искать его среди переписок по
    // свежести было бы неудобно.
    ...(selfChatId ? [{
      id: selfChatId,
      name: selfChatName,
      section: 'self' as ChatSection,
      groupLabel: null as string | null,
    }] : []),
    ...chatGroups.map(g => ({
      id: g.chat_id,
      name: g.name,
      section: 'group' as ChatSection,
      groupLabel: 'Группы' as string | null,
      chatGroupId: g.id,
      avatarPath: null as string | null,
    })),
    // Комментарий к имени раньше дописывался в скобках прямо в name — из-за
    // этого длинное имя с комментарием не помещалось в строку и обрезалось,
    // причём обрезался как раз комментарий. Теперь это отдельное поле и
    // отдельная строка карточки (см. row-comment в ChatList).
    ...allUsers.map(u => ({
      id: getChatId(u.id),
      name: nameFor(u),
      comment: comments[u.id]?.comment || null,
      section: 'staff' as ChatSection,
      groupLabel: u.groupName || 'Без группы',
      deletable: true,
      online: onlineUsers.includes(u.id),
      userId: u.id,
      avatarPath: u.avatarPath,
      status: describeStatus(u.statusPreset, u.statusCustom),
    }))
  ].sort((a, b) => {
      const rankDiff = groupRank(a) - groupRank(b);
      if (rankDiff !== 0) return rankDiff;
      const aTime = lastMessages[a.id] ? new Date(lastMessages[a.id].created_at).getTime() : 0;
      const bTime = lastMessages[b.id] ? new Date(lastMessages[b.id].created_at).getTime() : 0;
      return bTime - aTime;
    })
    // Избранным — свой ярлык раздела, чтобы не путался с их реальной группой.
    // Без жёсткой группировки заголовки отделов не нужны вовсе: ранг у всех
    // людей один, и разделитель разрезал бы список в случайном месте.
    .map(c => ({
      ...c,
      groupLabel: c.section !== 'general' && favorites.includes(c.id)
        ? 'Избранное'
        : (!uiPrefs.groupContacts && c.section === 'staff' ? null : c.groupLabel),
    }));

  // Поиск влияет только на основной список. Недавние строятся из полного
  // ростера и сохраняют порядок, который прислал сервер (последнее открытие
  // первым), иначе ввод одной буквы заставлял бы ярлыки исчезать и прыгать.
  const searchNeedle = searchQuery.toLowerCase();
  const chats = allChats.filter(c => (
    !searchNeedle
    || c.name.toLowerCase().includes(searchNeedle)
    || (c.comment || '').toLowerCase().includes(searchNeedle)
  ));
  const chatsById = new Map(allChats.map(chat => [chat.id, chat]));
  const recentChats = recentChatIds
    .map(chatId => chatsById.get(chatId))
    .filter((chat): chat is RosterChat => !!chat)
    .slice(0, 8);

  const typingText = activeChat ? typingUsers[activeChat] : undefined;

  // Данные для шапки переписки — независимо от текущего поискового фильтра списка
  const activeChatMeta: {
    name: string; section: ChatSection; online?: boolean; avatarPath?: string | null; userId?: number;
    chatGroupId?: number; memberCount?: number; isGroupOwner?: boolean;
    announcementsOnly?: boolean; canPostHere?: boolean; writePolicy?: WritePolicy;
    status?: { emoji: string; label: string } | null;
  } | null = (() => {
    if (!activeChat) return null;
    if (activeChat === GENERAL_CHAT_ID) return { name: 'Общий чат', section: 'general' };
    if (selfChatId && activeChat === selfChatId) return { name: selfChatName, section: 'self' };
    if (/^group_\d+$/.test(activeChat)) {
      const group = chatGroups.find(g => g.chat_id === activeChat);
      return group
        ? {
            name: group.name, section: 'group', chatGroupId: group.id, memberCount: group.member_count,
            isGroupOwner: group.role === 'owner', announcementsOnly: group.announcements_only,
            writePolicy: group.write_policy,
            // Право писать считает сервер (services/chatPermissions.js) и
            // присылает в can_post. Повторять правила на клиенте нельзя: две
            // копии одной логики неизбежно разъезжаются, и человек либо видит
            // открытый композер там, где отправка отлетит, либо наоборот.
            // can_post приходит только из REST-выдачи списка групп; на
            // socket-событие group_updated (оно одно на всех) его нет —
            // до перезагрузки списка считаем, что писать можно, а отказ
            // придёт от сервера через message_blocked.
            canPostHere: group.can_post !== false,
          }
        : null;
    }
    const user = allUsers.find(u => u.source === 'local' && getChatId(u.id) === activeChat);
    return user
      ? {
          name: nameFor(user), section: 'staff', online: onlineUsers.includes(user.id),
          avatarPath: user.avatarPath, userId: user.id,
          status: describeStatus(user.statusPreset, user.statusCustom),
        }
      : null;
  })();

  // Раньше искали только среди контактов (allUsers) — окно профиля молча не
  // открывалось для человека из «Люди», которого ещё не добавили в чаты
  // (аватар там кликабелен для всех, не только для уже добавленных). Теперь
  // при промахе смотрим в справочник (directory), который приходит с теми же
  // полями профиля — см. DirectoryUser выше.
  const infoModalUser: AllUser | null = (() => {
    if (infoModalUserId === null) return null;
    const contact = allUsers.find(u => u.id === infoModalUserId);
    if (contact) return contact;
    const dirUser = directory.find(u => u.id === infoModalUserId);
    if (!dirUser) return null;
    return {
      id: dirUser.id,
      username: dirUser.username,
      display_name: dirUser.display_name,
      avatarPath: dirUser.avatar_path,
      bio: dirUser.bio,
      phone: dirUser.phone,
      department: dirUser.department,
      position: dirUser.position,
      birthDate: dirUser.birth_date,
      source: 'local' as const,
      groupName: dirUser.group_name,
    };
  })();

  const isChats = section === 'chats';
  const activeSection = sectionById(section);

  // Через setView целиком, а не setSection + setSettingsView по отдельности:
  // раньше этот переход менял раздел, не трогая состояние переписки, — та же
  // ловушка, что чинили в кнопках «назад» у настроек и календаря.
  const openOwnProfile = () => {
    closeKeyboard();
    setProfileOpen(true);
  };

  // На узком экране список и переписка не сосуществуют: рисуется ровно одна
  // панель. Спрятанная трансформом переписка (как было раньше) при сбое
  // композитора оставалась поверх списка и запирала экран — см. useNarrowLayout.
  const showRoster = isChats && (!narrowLayout || !conversationOpen);
  const showConversation = isChats && (!narrowLayout || conversationOpen);

  return (
    <div
      className={'chat-layout'
        + (isChats ? '' : ' is-single-pane')
        + (conversationOpen ? ' is-conversation-view' : '')
        + (skipPaneAnim ? ' is-no-pane-anim' : '')}
      style={{ ['--roster-w' as string]: `${uiPrefs.rosterWidth}px` }}
    >
      <NotificationStack
        toasts={toasts}
        durationMs={notificationPrefs.durationMs}
        onOpen={(chatId) => {
          // Уведомление о задаче ведёт в раздел «Задачи»: переписки за ним нет.
          if (chatId === TASKS_TOAST_ID) goToSection('tasks');
          else handleSelectChat(chatId);
          dismissToast(chatId);
        }}
        onDismiss={dismissToast}
      />

      <NavRail
        active={section}
        // «Люди» — не раздел, а окно поверх текущего экрана: справочник
        // открывают, чтобы посмотреть человека и вернуться к тому, что делали,
        // а не чтобы уйти из переписки.
        onSelect={(id) => (id === 'people' ? setPeopleOpen(true) : goToSection(id))}
        unreadTotal={totalUnread}
        username={currentDisplayName}
        avatarPath={currentAvatarPath}
        online={socketConnected}
        statusPreset={currentStatusPreset}
        statusCustom={currentStatusCustom}
        onOpenProfile={openOwnProfile}
        accountType={currentAccountType}
      />

      {showRoster && (
      <ChatList
        selfName={currentDisplayName}
        selfAvatarPath={currentAvatarPath}
        statusPreset={currentStatusPreset}
        statusCustom={currentStatusCustom}
        onOpenStatus={() => setStatusSheetOpen(true)}
        customEmoji={customEmoji}
        chats={chats}
        recentChats={recentChats}
        activeChat={activeChat}
        onSelectChat={handleSelectChat}
        onOpenDirectory={() => setDirectoryOpen(true)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        lastMessages={lastMessages}
        unreadCounts={unreadCounts}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onMarkAllRead={handleMarkAllRead}
        onRemoveContact={handleRemoveContact}
        onOpenUserInfo={(userId) => setInfoModalUserId(userId)}
        onOpenGroupInfo={(chatGroupId) => setGroupInfoId(chatGroupId)}
        onCreateGroup={() => setCreateGroupOpen(true)}
        onOpenSettings={() => goToSection('settings')}
        resizeHandle={!narrowLayout && (
          <div
            className="roster-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Ширина списка чатов"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={() => saveUiPrefs({ ...uiPrefsRef.current, rosterWidth: DEFAULT_UI_PREFS.rosterWidth })}
            title="Потяните, чтобы изменить ширину. Двойной клик — вернуть по умолчанию"
          />
        )}
      />
      )}
      {directoryOpen && (
        <DirectoryModal
          existingContactIds={users.map(u => u.id)}
          onClose={() => setDirectoryOpen(false)}
          onSelectUser={handleStartChat}
        />
      )}
      {createGroupOpen && (
        <CreateGroupModal
          onClose={() => setCreateGroupOpen(false)}
          onCreated={(group: CreatedGroup) => {
            // Не через handleSelectChat: он сверяется со списком групп в
            // React-стейте, а setChatGroups выше применится только со
            // следующим рендером — сразу после вызова список ещё старый, и
            // проверка отвергла бы только что созданную группу.
            setChatGroups(prev => prev.some(g => g.id === group.id) ? prev : [...prev, { ...group, role: 'owner' as const }]);
            setCreateGroupOpen(false);
            setActiveChat(group.chat_id);
            recordRecentOpening(group.chat_id);
            setView(VIEW_CONVERSATION);
          }}
        />
      )}
      {groupInfoId !== null && (
        <GroupInfoModal
          groupId={groupInfoId}
          currentUserId={currentUserId}
          onClose={() => setGroupInfoId(null)}
          onUpdated={(group) => {
            setChatGroups(prev => prev.map(g => g.id === group.id
              ? { ...g, name: group.name, member_count: group.member_count }
              : g));
          }}
          onGone={(chatId) => {
            setChatGroups(prev => prev.filter(g => g.chat_id !== chatId));
            setGroupInfoId(null);
            if (activeChat === chatId) { setActiveChat(null); setView(VIEW_CHAT_LIST); }
          }}
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
          comment={comments[infoModalUser.id]?.comment || ''}
          onUpdateComment={(comment) => updateComment(infoModalUser.id, comment)}
          onClose={() => setInfoModalUserId(null)}
        />
      )}
      {section === 'settings' && (
        <main className="section-host">
          <SettingsPanel
            username={currentDisplayName}
            avatarPath={currentAvatarPath}
            onClose={() => goToSection('chats')}
            onOpenProfile={openOwnProfile}
            onDeleteAccount={handleDeleteSelf}
            onLogout={handleLogout}
          />
        </main>
      )}

      {profileOpen && (
        <div className="modal-overlay" onClick={() => setProfileOpen(false)}>
          <div className="modal-card profile-modal" onClick={(e) => e.stopPropagation()}>
            <ProfileEdit
              currentUsername={currentUsername}
              currentDisplayName={currentDisplayName}
              currentAvatarPath={currentAvatarPath}
              currentBio={currentBio}
              currentPhone={currentPhone}
              currentDepartment={currentDepartment}
              currentPosition={currentPosition}
              currentBirthDate={currentBirthDate}
              statusPreset={currentStatusPreset}
              statusCustom={currentStatusCustom}
              onStatusChanged={(preset, custom) => {
                setCurrentStatusPreset(preset);
                setCurrentStatusCustom(custom);
                localStorage.setItem('statusPreset', preset || '');
                localStorage.setItem('statusCustom', custom || '');
              }}
              onBack={() => setProfileOpen(false)}
              onSaved={handleProfileSaved}
              onAvatarChanged={handleAvatarChanged}
            />
          </div>
        </div>
      )}

      {deleteRequest && (
        <DeleteMessagesModal
          request={deleteRequest}
          onCancel={() => setDeleteRequest(null)}
          onConfirm={performDelete}
        />
      )}

      {forwardIds && (
        <ForwardModal
          customEmoji={customEmoji}
          items={messages
            .filter((m) => forwardIds.includes(m.id) && !m.deleted)
            .sort((a, b) => a.id - b.id)
            .map((m): ForwardPreviewItem => ({
              id: m.id,
              text: m.text,
              author: nameFor(m),
              hasImage: !!m.file_path,
            }))}
          targets={chats.map((c): ForwardTarget => ({
            id: c.id,
            name: c.name,
            section: c.section,
            avatarPath: (c as { avatarPath?: string | null }).avatarPath,
            // В канал-объявление без прав переслать нельзя — сервер такое
            // сообщение отклонит, так что и предлагать его незачем.
            disabled: (() => {
              const group = chatGroups.find((g) => g.chat_id === c.id);
              if (!group?.announcements_only) return false;
              return currentUserRole !== 'admin' && currentUserRole !== 'moderator';
            })(),
          }))}
          onClose={() => setForwardIds(null)}
          onConfirm={handleForward}
        />
      )}

      {statusSheetOpen && (
        <StatusSheet
          statusPreset={currentStatusPreset}
          statusCustom={currentStatusCustom}
          onStatusChanged={(preset, custom) => {
            setCurrentStatusPreset(preset);
            setCurrentStatusCustom(custom);
            localStorage.setItem('statusPreset', preset || '');
            localStorage.setItem('statusCustom', custom || '');
          }}
          onClose={() => setStatusSheetOpen(false)}
        />
      )}

      {peopleOpen && (
        <div className="modal-overlay" onClick={() => setPeopleOpen(false)}>
          <div className="modal-card people-modal" onClick={(e) => e.stopPropagation()}>
            <PeopleSection
              currentUserId={currentUserId}
              existingContactIds={users.map(u => u.id)}
              onlineUserIds={onlineUsers}
              onOpenChat={(user) => { setPeopleOpen(false); handleStartChat(user); }}
              onOpenUserInfo={(userId) => setInfoModalUserId(userId)}
              onAddContact={handleAddContact}
              onClose={() => setPeopleOpen(false)}
            />
          </div>
        </div>
      )}

      {section === 'calendar' && (
        <main className="section-host">
          <CalendarSection section={activeSection} onBack={() => goToSection('chats')} />
        </main>
      )}

      {section === 'tasks' && (
        <main className="section-host">
          <TasksPanel
            currentUserId={currentUserId}
            changeToken={tasksChangeToken}
            draftDescription={taskDraftText}
            onDraftConsumed={() => setTaskDraftText(null)}
          />
        </main>
      )}

      {!isChats && section !== 'settings' && section !== 'calendar' && section !== 'tasks' && (
        <main className="section-host">
          <SectionStub section={activeSection} onBack={() => goToSection('chats')} />
        </main>
      )}

      {showConversation && (
        <main className="conversation">
          <div className="conv-head">
            <button type="button" className="icon-btn back-btn" onClick={leaveConversation} aria-label="Назад к списку">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
            </button>

            {activeChatMeta ? (
              <button
                type="button"
                className="conv-head-identity"
                onClick={() => {
                  if (activeChatMeta.userId) setInfoModalUserId(activeChatMeta.userId);
                  else if (activeChatMeta.chatGroupId) setGroupInfoId(activeChatMeta.chatGroupId);
                }}
                disabled={!activeChatMeta.userId && !activeChatMeta.chatGroupId}
              >
                <Avatar
                  name={activeChatMeta.name}
                  avatarPath={activeChatMeta.avatarPath}
                  size="sm"
                  isGeneral={activeChatMeta.section === 'general'}
                  isGroup={activeChatMeta.section === 'group'}
                />
                <div className="conv-title">
                  <div className="name">{activeChatMeta.name}</div>
                  {/* «печатает…» вытесняет статус в самой шапке — так это
                      показывает Telegram, и индикатор виден, даже когда
                      переписка прокручена не до конца. */}
                  {typingText ? (
                    <div className="status is-typing">
                      {activeChatMeta.section === 'general' || activeChatMeta.section === 'group' ? `${typingText} печатает` : 'печатает'}
                      <span className="typing-dots"><span /><span /><span /></span>
                    </div>
                  ) : activeChatMeta.section === 'group' ? (
                    <div className="status">{activeChatMeta.memberCount} участников</div>
                  ) : activeChatMeta.section === 'self' ? (
                    <div className="status is-broadcast">заметки и пересылки, видите только вы</div>
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
            showAuthors={activeChat === GENERAL_CHAT_ID || activeChatMeta?.section === 'group'}
            onDeleteMessages={requestDelete}
            onScrollTop={loadMoreMessages}
            hasMore={hasMore}
            loadingMore={loadingMore}
            unreadCount={activeChat ? unreadCounts[activeChat] : 0}
            onStartEdit={(id, text) => setEditingMessage({ id, text })}
            editingId={editingMessage?.id ?? null}
            onDeleteMessage={(id) => requestDelete([id])}
            // Аккаунтам «Интернет» раздел «Задачи» не положен — пункт меню им
            // не показываем вовсе, иначе он молча возвращал бы в чаты.
            // Коды смайликов в описание задачи не уезжают: задача — не
            // переписка, её описание правят в обычном поле и читают в списках,
            // где картинку показать нечем. Подставляем базовый эмодзи сразу.
            onCreateTask={isSectionAllowedFor(currentAccountType, 'tasks')
              ? (text) => { setTaskDraftText(toPlainText(text, customEmoji)); goToSection('tasks'); }
              : undefined}
            onStartReply={setReplyingMessage}
            onForward={(ids) => setForwardIds(ids)}
            reactionEmoji={reactionEmoji}
            customEmoji={customEmoji}
            onToggleReaction={handleToggleReaction}
            onRemoveReaction={handleRemoveReaction}
            onForwardToSelf={selfChatId ? (ids) => forwardTo(ids, selfChatId, false) : undefined}
            selfChatName={selfChatName}
          />
          {muted && (
            <div className="muted-banner">
              Ваш аккаунт временно ограничен — отправка сообщений недоступна.
            </div>
          )}
          {!muted && activeChatMeta?.section === 'group' && activeChatMeta.canPostHere === false && (
            <div className="muted-banner">
              {WRITE_BLOCKED_HINT[activeChatMeta.writePolicy || 'nobody']}
            </div>
          )}
          <MessageInput
            onSend={handleSendMessage}
            onTyping={handleTyping}
            disabled={!activeChat || muted || activeChatMeta?.canPostHere === false}
            placeholder={
              muted
                ? 'Отправка сообщений ограничена'
                : activeChatMeta?.canPostHere === false
                  ? WRITE_BLOCKED_HINT[activeChatMeta.writePolicy || 'nobody']
                // Статус собеседника прямо в поле ввода: видно ровно в тот
                // момент, когда собираешься писать, — не нужно вспоминать,
                // что человек в отпуске, уже отправив сообщение. Имя здесь
                // намеренно повторяется, хотя оно есть и в шапке: формат
                // «Сообщение {Имя} {статус}» выбран пользователем и сейчас
                // проверяется на живых людях — не «чинить» обратно.
                : activeChatMeta?.status
                  ? `Сообщение ${activeChatMeta.name} ${activeChatMeta.status.emoji} ${activeChatMeta.status.label}`
                  : undefined
            }
            customEmoji={customEmoji}
            editing={editingMessage}
            onSubmitEdit={handleEditMessage}
            onCancelEdit={() => setEditingMessage(null)}
            onRequestEditLast={requestEditLast}
            replying={replyingMessage}
            onCancelReply={() => setReplyingMessage(null)}
          />
        </main>
      )}
    </div>
  );
};

export default Chat;
