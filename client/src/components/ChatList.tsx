import React from 'react';
import Avatar from './Avatar';
import { formatChatListTime } from '../utils/time';
import { describeStatus } from '../utils/statusMeta';
import { CustomEmojiMap, renderTextWithEmoji } from '../utils/customEmoji';
import WebDownloadLinks from './WebDownloadLinks';
import { resolveUploadUrl } from '../utils/uploads';
import IosInstallHint from './IosInstallHint';

export type ChatSection = 'general' | 'staff' | 'group' | 'self';

export interface Chat {
  id: string;
  name: string;
  section: ChatSection;
  groupLabel: string | null;
  online?: boolean;
  userId?: number;
  avatarPath?: string | null;
  deletable?: boolean;
  /** Только у групповых чатов — id для GroupInfoModal, отличный от chat.id ('group_<id>'). */
  chatGroupId?: number;
  /** Статус собеседника («в отпуске» и т.п.) — показывается справа от имени. */
  status?: { emoji: string; label: string } | null;
  /** Комментарий к имени — отдельной строкой между именем и превью. */
  comment?: string | null;
  /** Канал-объявление: такие группы попадают в фильтр «Новостные». */
  announcementsOnly?: boolean;
}

interface LastMessage {
  chat_id: string;
  message_id?: number;
  text: string;
  file_path?: string | null;
  sticker_id?: number | null;
  sticker_fallback?: string | null;
  document_name?: string | null;
  created_at: string;
  /** Кто отправил — от этого зависят и подпись автора, и галочки. */
  sender_id?: number;
  sender_name?: string | null;
  status?: 'sent' | 'delivered' | 'read' | string;
}

interface ChatListProps {
  /** Свой аватар и статус в шапке — вход в выбор статуса одним тапом. */
  selfName: string;
  selfAvatarPath: string | null;
  statusPreset: string | null;
  statusCustom: string | null;
  /** Срок действия своего статуса — показывается в блоке «Мой статус». */
  statusExpiresAt?: number | null;
  /** Нужен, чтобы отличить своё последнее сообщение: у него в превью галочки. */
  currentUserId: number;
  onOpenStatus: () => void;
  /** Каталог кастомных смайликов — превью тоже показывает текст сообщения. */
  customEmoji?: CustomEmojiMap;
  chats: Chat[];
  recentChats: Chat[];
  activeChat: string | null;
  threadsActive?: boolean;
  threadUnreadCount?: number;
  onOpenThreads?: () => void;
  onSelectChat: (chatId: string) => void;
  onOpenDirectory: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  lastMessages: Record<string, LastMessage>;
  unreadCounts: Record<string, number>;
  favorites: string[];
  onToggleFavorite: (chatId: string) => void;
  onMarkAllRead: () => void;
  onRemoveContact: (userId: number) => void;
  /** Заглушённые чаты — пункт меню показывает, включить или выключить. */
  mutedChatIds?: string[];
  onToggleMute?: (chatId: string, muted: boolean) => void;
  /** Пометить один чат прочитанным (не всё подряд, как кнопка в шапке). */
  onMarkChatRead?: (chatId: string) => void;
  /** Очистить переписку у обеих сторон — только личные чаты. */
  onClearChat?: (chatId: string, chatName: string) => void;
  onOpenUserInfo: (userId: number) => void;
  onOpenGroupInfo: (chatGroupId: number) => void;
  onOpenGeneralInfo?: () => void;
  onCreateGroup: () => void;

  /** Ручка растягивания панели — только на широком экране, рисует Chat.tsx. */
  resizeHandle?: React.ReactNode;
  /**
   * Компактный список — только аватары и индикаторы.
   *
   * Это ФЛАГ ПРЕДСТАВЛЕНИЯ у того же компонента, а не отдельный «CompactChatList»:
   * список остаётся один, с той же логикой отбора, сортировки и обработки
   * нажатий, — прячется лишь то, чему не хватает ширины. Второй компонент
   * означал бы вторую реализацию тех же правил, расходящуюся с первой.
   */
  compact?: boolean;
  /** Развернуть список обратно — кнопка внутри компактного состояния. */
  onExpand?: () => void;
}

function renderAvatar(
  chat: Chat,
  onOpenUserInfo: (userId: number) => void,
  onOpenGroupInfo: (chatGroupId: number) => void,
  onOpenGeneralInfo?: () => void,
) {
  const avatar = (
    <Avatar
      name={chat.name}
      avatarPath={chat.avatarPath}
      online={chat.online}
      isGeneral={chat.section === 'general'}
      isGroup={chat.section === 'group'}
      isSelf={chat.section === 'self'}
    />
  );
  if (chat.userId) {
    return (
      <button type="button" className="row-avatar-btn" onClick={(e) => { e.stopPropagation(); onOpenUserInfo(chat.userId!); }} aria-label="Профиль">
        {avatar}
      </button>
    );
  }
  if (chat.chatGroupId) {
    return (
      <button type="button" className="row-avatar-btn" onClick={(e) => { e.stopPropagation(); onOpenGroupInfo(chat.chatGroupId!); }} aria-label="О группе">
        {avatar}
      </button>
    );
  }
  // У общего чата нет ни собеседника, ни строки в chat_groups — своя ветка.
  if (chat.section === 'general' && onOpenGeneralInfo) {
    return (
      <button type="button" className="row-avatar-btn" onClick={(e) => { e.stopPropagation(); onOpenGeneralInfo(); }} aria-label="Об общем чате">
        {avatar}
      </button>
    );
  }
  return avatar;
}

// Долгое удержание на строке чата — тот же вход в меню, что правый клик на
// ПК: на телефоне правого клика нет вовсе, а меню должно открываться и там.
const ROW_LONG_PRESS_MS = 450;

/**
 * Фильтры списка чатов.
 *
 * Это именно фильтрация ОДНОГО списка, а не отдельные экраны: порядок,
 * закрепления и счётчики остаются теми же, меняется только состав.
 *
 * «Новостные» — то, что читают, а не обсуждают: каналы-объявления
 * (`announcements_only`) и общий чат, который и подписан как рассылка на всю
 * организацию. Обычные группы к ним не относятся, даже если в них тихо.
 */
export type ChatFilter = 'all' | 'direct' | 'groups' | 'news';

const FILTERS: { id: ChatFilter; label: string }[] = [
  { id: 'all', label: 'Все чаты' },
  { id: 'direct', label: 'Личные' },
  { id: 'groups', label: 'Группы' },
  { id: 'news', label: 'Новостные' },
];

function matchesFilter(chat: Chat, filter: ChatFilter): boolean {
  if (filter === 'all') return true;
  const isNews = chat.section === 'general' || !!chat.announcementsOnly;
  if (filter === 'news') return isNews;
  if (filter === 'groups') return chat.section === 'group' && !isNews;
  // «Личные» — переписка с человеком и своё «Избранное»: это тоже личное
  // пространство, и прятать его в «Все чаты» значило бы терять к нему путь.
  return chat.section === 'staff' || chat.section === 'self';
}

const ChatList: React.FC<ChatListProps> = ({
  chats, recentChats, activeChat, threadsActive = false, threadUnreadCount = 0, onOpenThreads = () => {},
  onSelectChat, onOpenDirectory, searchQuery, onSearchChange,
  lastMessages, unreadCounts, favorites, onToggleFavorite,
  onMarkAllRead, onRemoveContact, onOpenUserInfo, onOpenGroupInfo, onOpenGeneralInfo, onCreateGroup,
  mutedChatIds = [], onToggleMute, onMarkChatRead, onClearChat,
  resizeHandle,
  compact = false,
  onExpand,
  selfName, selfAvatarPath, statusPreset, statusCustom, statusExpiresAt = null, currentUserId,
  onOpenStatus, customEmoji = {},
}) => {
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const recentStripRef = React.useRef<HTMLDivElement>(null);
  const [searchFocused, setSearchFocused] = React.useState(false);
  // Контекстное меню строки чата. Держим id чата, а не сам объект: список
  // перестраивается на каждое входящее сообщение, и меню, привязанное к старому
  // объекту, работало бы с устаревшими данными.
  const [filter, setFilter] = React.useState<ChatFilter>('all');
  const [rowMenu, setRowMenu] = React.useState<{ chatId: string; x: number; y: number } | null>(null);
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = React.useRef(false);
  React.useEffect(() => () => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }, []);

  const openRowMenu = (chatId: string, x: number, y: number) => {
    // Меню не должно уезжать за край: список чатов сам прокручивается, и у
    // нижних строк оно оказалось бы за экраном.
    setRowMenu({
      chatId,
      x: Math.min(x, window.innerWidth - 230),
      y: Math.min(y, window.innerHeight - 260),
    });
  };
  const [mobileSearchCollapsed, setMobileSearchCollapsed] = React.useState(false);
  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0) + threadUnreadCount;
  const ownStatus = describeStatus(statusPreset, statusCustom);
  // Срок показывается вместо подсказки: «до 19:00» полезнее, чем «изменить
  // статус», — человек и так понимает, что по блоку можно нажать.
  const statusUntil = ownStatus && statusExpiresAt
    ? `до ${new Date(statusExpiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    : '';
  // Ищем и по комментарию к имени — он больше не часть name (см. row-comment).
  const needle = searchQuery.toLowerCase();
  const filtered = chats.filter(c => (
    matchesFilter(c, filter)
    && (
      !needle
      || c.name.toLowerCase().includes(needle)
      || (c.comment || '').toLowerCase().includes(needle)
    )
  ));

  let lastGroupLabel: string | null = null;

  const isNarrowScreen = () => window.matchMedia('(max-width: 760px)').matches;

  const handleRosterScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!isNarrowScreen() || searchQuery) return;
    const shouldCollapse = event.currentTarget.scrollTop > 18;
    if (shouldCollapse) {
      searchInputRef.current?.blur();
      setSearchFocused(false);
    }
    setMobileSearchCollapsed(shouldCollapse);
  };

  const openMobileSearch = () => {
    setMobileSearchCollapsed(false);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  // У Electron вертикальное колесо над горизонтальной лентой должно листать
  // контакты, а не чат-лист под ней. Тач-прокрутку браузер обрабатывает сам.
  const handleRecentWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = recentStripRef.current;
    if (!strip || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  };


  return (
    <aside className={'roster' + (mobileSearchCollapsed ? ' is-search-collapsed' : '') + (compact ? ' is-compact' : '')}>
      {resizeHandle}
      {compact && onExpand && (
        // Компактный список — полноценное состояние панели, из него обязан
        // быть выход без изменения размера всего окна.
        <button type="button" className="roster-expand-btn" onClick={onExpand} title="Развернуть список чатов" aria-label="Развернуть список чатов">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      )}
      <div className="roster-head">
        {/* Аватар со статусом отсюда убран: со сменой навигации настройки и
            профиль переехали в нижнюю панель, а свой статус получил
            собственный блок под фильтрами (.roster-mystatus). Шапка снова
            занята только тем, что относится к самому списку. */}
        <div className="roster-account">
          <div className="roster-heading">Чаты</div>
          <WebDownloadLinks />
          {totalUnread > 0 && (
            <>
              <span className="row-unread">{totalUnread}</span>
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
          <button
            type="button"
            className="roster-search-open-btn"
            title="Поиск чатов"
            aria-label="Открыть поиск чатов"
            onClick={openMobileSearch}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          </button>
        </div>
        {/* Подсказка про ярлык на iPhone — здесь же, где кнопки скачивания
            для остальных платформ: это ровно то же самое действие «поставить
            приложение к себе», просто у iOS оно делается руками. */}
        {!compact && <IosInstallHint />}
        <div className={'roster-search-area' + (searchFocused || !!searchQuery ? ' is-recent-open' : '')}>
          <div className="search">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Поиск"
              value={searchQuery}
              onFocus={() => { setSearchFocused(true); setMobileSearchCollapsed(false); }}
              onBlur={() => setSearchFocused(false)}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <button type="button" className="icon-btn-ghost new-chat-btn" title="Найти сотрудника" onClick={onOpenDirectory}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" className="icon-btn-ghost new-chat-btn" title="Создать группу" onClick={onCreateGroup}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            </button>
          </div>
          {recentChats.length > 0 && (
            <div
              ref={recentStripRef}
              className="recent-chats"
              aria-label="Недавние чаты"
              onWheel={handleRecentWheel}
            >
              {recentChats.map((chat) => (
                <button
                  type="button"
                  className="recent-chat"
                  key={chat.id}
                  title={chat.name}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <Avatar
                    name={chat.name}
                    avatarPath={chat.avatarPath}
                    online={chat.online}
                    isGroup={chat.section === 'group'}
                    isSelf={chat.section === 'self'}
                  />
                  <span>{chat.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Фильтры и свой статус — над списком, но ВНЕ прокручиваемой области
          заголовка: на узком экране они уезжают вместе с поиском при прокрутке
          вниз, освобождая экран под переписки. */}
      {!compact && (
        <div className="roster-filters" role="tablist" aria-label="Фильтр чатов">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={'roster-filter' + (filter === item.id ? ' is-active' : '')}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {!compact && (
        <button
          type="button"
          className="roster-mystatus"
          onClick={onOpenStatus}
          title={ownStatus ? 'Изменить статус' : 'Установить статус'}
        >
          <Avatar name={selfName} avatarPath={selfAvatarPath} size="sm" online />
          <span className="roster-mystatus-body">
            <span className="roster-mystatus-title">
              {ownStatus ? `${ownStatus.emoji} ${ownStatus.label}` : 'Мой статус'}
            </span>
            <span className="roster-mystatus-hint">
              {statusUntil || (ownStatus ? 'Изменить статус' : 'Установить статус')}
            </span>
          </span>
        </button>
      )}

      <div className="roster-list" onScroll={handleRosterScroll}>
        {/* «Ветки» — не чат, а вход в отдельный список обсуждений. В
            отфильтрованных видах его быть не должно: он не «личный», не
            «группа» и не «новостной». */}
        {filter === 'all' && (
        <div
          tabIndex={0}
          role="button"
          aria-current={threadsActive}
          className={'row threads-roster-row' + (threadsActive ? ' is-active' : '')}
          onClick={onOpenThreads}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenThreads(); } }}
        >
          <span className="threads-roster-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></svg>
          </span>
          <div className="row-body">
            <div className="row-top"><div className="row-name"><span>Ветки</span></div></div>
            <div className="row-bottom">
              <div className="row-preview">Все обсуждения</div>
              {threadUnreadCount > 0 && <span className="row-unread">{threadUnreadCount}</span>}
            </div>
          </div>
        </div>
        )}
        {filtered.length === 0 && <div className="roster-empty">Ничего не найдено</div>}
        {filtered.map((chat) => {
          const last = lastMessages[chat.id];
          const unreadCount = unreadCounts[chat.id] || 0;
          const isFavorite = favorites.includes(chat.id);
          const isMuted = mutedChatIds.includes(chat.id);
          const showLabel = chat.groupLabel !== lastGroupLabel;
          lastGroupLabel = chat.groupLabel;

          // Галочки показываем только у СВОЕГО последнего сообщения: у чужого
          // статус относится к чтению собеседником и в списке ничего не значит.
          const mine = !!last && last.sender_id === currentUserId;
          const outgoingStatus = mine ? (last!.status || 'sent') : null;
          const previewThumb = last && last.file_path ? resolveUploadUrl(last.file_path) : null;
          // Имя автора в превью — там, где собеседник не один: в личной
          // переписке оно повторяло бы название самой строки.
          const showAuthor = !!last && (chat.section === 'general' || chat.section === 'group');
          const previewPrefix = last && showAuthor && last.sender_name
            ? `${mine ? 'Вы' : last.sender_name}: `
            : '';
          const previewBody = last
            ? (renderTextWithEmoji(last.text || '', customEmoji, `p${chat.id}`)
              || (last.sticker_fallback ? `${last.sticker_fallback} Стикер` : '')
              || (last.document_name ? `📎 ${last.document_name}` : '')
              || (last.file_path ? 'Фотография' : ''))
            : '';

          return (
            <React.Fragment key={chat.id}>
              {showLabel && chat.groupLabel && (
                <div className="roster-section">{chat.groupLabel}</div>
              )}
              <div
                tabIndex={0}
                role="button"
                aria-current={activeChat === chat.id}
                className={'row' + (activeChat === chat.id ? ' is-active' : '')}
                onClick={() => {
                  // После удержания приходит синтетический click — он не должен
                  // открывать чат под уже открытым меню.
                  if (longPressFired.current) { longPressFired.current = false; return; }
                  onSelectChat(chat.id);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectChat(chat.id); } }}
                onContextMenu={(e) => { e.preventDefault(); openRowMenu(chat.id, e.clientX, e.clientY); }}
                onTouchStart={(e) => {
                  longPressFired.current = false;
                  const touch = e.touches[0];
                  longPressTimer.current = setTimeout(() => {
                    longPressFired.current = true;
                    openRowMenu(chat.id, touch.clientX, touch.clientY);
                  }, ROW_LONG_PRESS_MS);
                }}
                onTouchMove={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
                onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
              >
                {renderAvatar(chat, onOpenUserInfo, onOpenGroupInfo, onOpenGeneralInfo)}
                <div className="row-body">
                  <div className="row-top">
                    <div className="row-name">
                      <span>{chat.name}</span>
                      {/* Перечёркнутый колокольчик — у самого имени, а не в
                          правой колонке: там уже время, галочки и счётчик, и
                          признак «этот чат молчит» терялся среди них. */}
                      {isMuted && (
                        <span className="row-muted" title="Уведомления отключены" aria-label="Уведомления отключены">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 8a6 6 0 0 0-9.3-5" /><path d="M6 8c0 7-3 9-3 9h13" />
                            <path d="M13.7 21a2 2 0 0 1-3.4 0" /><path d="m2 2 20 20" />
                          </svg>
                        </span>
                      )}
                      {chat.status && (
                        <span className="row-status" title={chat.status.label}>
                          {chat.status.emoji} {chat.status.label}
                        </span>
                      )}
                    </div>
                    <div className="row-side">
                      {/* Закрепление и время — одна плашка, а не два элемента:
                          закреплённый чат должен узнаваться сразу, но ради
                          этого нельзя занимать ещё одну колонку в строке. */}
                      {(last || isFavorite) && (
                        <div className={'row-stamp' + (isFavorite ? ' is-pinned' : '')}>
                          {isFavorite && (
                            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M14 3.5 20.5 10l-2.2.6a3 3 0 0 0-1.5.9l-2.6 2.9 1 3.4-1.4 1.4-3.6-3.6-4.6 4-.7-.7 4-4.6L5.3 11l1.4-1.4 3.4 1 2.9-2.6a3 3 0 0 0 .9-1.5Z" />
                            </svg>
                          )}
                          {last ? formatChatListTime(last.created_at) : 'закреплён'}
                        </div>
                      )}
                      {/* Галочки — то же состояние, что и в самой переписке:
                          отдельной механики статусов тут не заводится. */}
                      {outgoingStatus && (
                        <span
                          className={'row-check' + (outgoingStatus === 'read' ? ' is-read' : '')}
                          title={outgoingStatus === 'read' ? 'Прочитано' : 'Доставлено'}
                          aria-label={outgoingStatus === 'read' ? 'Прочитано' : 'Доставлено'}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m1.5 12.5 4 4 8-9" />
                            {outgoingStatus !== 'sent' && <path d="m10 16.5 8-9" />}
                          </svg>
                        </span>
                      )}
                      {unreadCount > 0 && <span className="row-unread">{unreadCount > 999 ? '999+' : unreadCount}</span>}
                    </div>
                  </div>
                  {chat.comment && <div className="row-comment">{chat.comment}</div>}
                  <div className="row-bottom">
                    {/* Миниатюра — часть превью, а не отдельная колонка: она
                        стоит перед текстом и не растит высоту строки. */}
                    {previewThumb && (
                      <img className="row-thumb" src={previewThumb} alt="" loading="lazy" decoding="async" />
                    )}
                    <div className="row-preview">
                      {previewPrefix && <span className="row-preview-author">{previewPrefix}</span>}
                      {previewBody}
                    </div>
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {rowMenu && (() => {
        const chat = chats.find((item) => item.id === rowMenu.chatId);
        if (!chat) return null;
        const isFavorite = favorites.includes(chat.id);
        const isMuted = mutedChatIds.includes(chat.id);
        const unread = unreadCounts[chat.id] || 0;
        // Очистка «у обеих сторон» — только личная переписка: в группе и общем
        // чате это чужая переписка для десятков людей.
        const canClear = !!onClearChat && (chat.section === 'staff' || chat.section === 'self');
        const close = () => setRowMenu(null);

        return (
          <>
            <div
              className="attachments-menu-backdrop"
              onClick={close}
              onContextMenu={(e) => { e.preventDefault(); close(); }}
            />
            <div className="attachments-menu row-menu" style={{ left: rowMenu.x, top: rowMenu.y }}>
              <button type="button" onClick={() => { close(); onToggleFavorite(chat.id); }}>
                {isFavorite ? 'Открепить' : 'Закрепить'}
              </button>
              {unread > 0 && onMarkChatRead && (
                <button type="button" onClick={() => { close(); onMarkChatRead(chat.id); }}>
                  Пометить прочитанным
                </button>
              )}
              {onToggleMute && (
                <button type="button" onClick={() => { close(); onToggleMute(chat.id, !isMuted); }}>
                  {isMuted ? 'Включить уведомления' : 'Отключить уведомления'}
                </button>
              )}
              {canClear && (
                <button type="button" className="is-danger" onClick={() => { close(); onClearChat!(chat.id, chat.name); }}>
                  Очистить переписку
                </button>
              )}
              {chat.userId && (
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => { close(); onRemoveContact(chat.userId!); }}
                >
                  Убрать из контактов
                </button>
              )}
            </div>
          </>
        );
      })()}
    </aside>
  );
};

export default ChatList;
