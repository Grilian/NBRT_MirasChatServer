import React from 'react';
import Avatar from './Avatar';
import { formatChatListTime } from '../utils/time';
import { describeStatus } from '../utils/statusMeta';
import { CustomEmojiMap, renderTextWithEmoji } from '../utils/customEmoji';

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
}

interface LastMessage {
  text: string;
  file_path?: string | null;
  created_at: string;
}

interface ChatListProps {
  /** Свой аватар и статус в шапке — вход в выбор статуса одним тапом. */
  selfName: string;
  selfAvatarPath: string | null;
  statusPreset: string | null;
  statusCustom: string | null;
  onOpenStatus: () => void;
  /** Каталог кастомных смайликов — превью тоже показывает текст сообщения. */
  customEmoji?: CustomEmojiMap;
  chats: Chat[];
  recentChats: Chat[];
  activeChat: string | null;
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
  onOpenUserInfo: (userId: number) => void;
  onOpenGroupInfo: (chatGroupId: number) => void;
  onCreateGroup: () => void;
  /** Только для узкого экрана — на нём в нижней панели «Настройкам» не хватило
      места (см. .rail-item-settings в theme.css), поэтому вход туда здесь. */
  onOpenSettings: () => void;
  /** Ручка растягивания панели — только на широком экране, рисует Chat.tsx. */
  resizeHandle?: React.ReactNode;
}

function renderAvatar(chat: Chat, onOpenUserInfo: (userId: number) => void, onOpenGroupInfo: (chatGroupId: number) => void) {
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
  return avatar;
}

const ChatList: React.FC<ChatListProps> = ({
  chats, recentChats, activeChat, onSelectChat, onOpenDirectory, searchQuery, onSearchChange,
  lastMessages, unreadCounts, favorites, onToggleFavorite,
  onMarkAllRead, onRemoveContact, onOpenUserInfo, onOpenGroupInfo, onCreateGroup, onOpenSettings,
  resizeHandle,
  selfName, selfAvatarPath, statusPreset, statusCustom, onOpenStatus, customEmoji = {},
}) => {
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const recentStripRef = React.useRef<HTMLDivElement>(null);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [mobileSearchCollapsed, setMobileSearchCollapsed] = React.useState(false);
  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
  const ownStatus = describeStatus(statusPreset, statusCustom);
  // Ищем и по комментарию к имени — он больше не часть name (см. row-comment).
  const needle = searchQuery.toLowerCase();
  const filtered = chats.filter(c => (
    !needle
    || c.name.toLowerCase().includes(needle)
    || (c.comment || '').toLowerCase().includes(needle)
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
    <aside className={'roster' + (mobileSearchCollapsed ? ' is-search-collapsed' : '')}>
      {resizeHandle}
      <div className="roster-head">
        {/* Свой аватар со статусом. На телефоне блок «себя» с рельса скрыт
            (там шесть вкладок), и до статуса приходилось идти через настройки
            и правку профиля — три уровня, до которых догадывался не каждый.
            Тап открывает только выбор статуса, не весь профиль. */}
        <div className="roster-account">
          <button
            type="button"
            className="roster-self"
            onClick={onOpenStatus}
            title={ownStatus ? ownStatus.label : 'Поставить статус'}
            aria-label={ownStatus ? `Статус: ${ownStatus.label}` : 'Поставить статус'}
          >
            <Avatar name={selfName} avatarPath={selfAvatarPath} size="sm" online />
            {ownStatus && <span className="roster-self-status">{ownStatus.emoji}</span>}
          </button>
          <div className="roster-heading">Чаты</div>
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
          {/* Видна только на узком экране — там же скрыт пункт «Настройки» в
              нижней панели (не помещался без прокрутки). На десктопе вход в
              настройки остаётся на рельсе, поэтому здесь дублировать не нужно. */}
          <button
            type="button"
            className="roster-settings-btn"
            title="Настройки"
            aria-label="Настройки"
            onClick={onOpenSettings}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" /></svg>
          </button>
        </div>
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

      <div className="roster-list" onScroll={handleRosterScroll}>
        {filtered.length === 0 && <div className="roster-empty">Ничего не найдено</div>}
        {filtered.map((chat) => {
          const last = lastMessages[chat.id];
          const unreadCount = unreadCounts[chat.id] || 0;
          const isFavorite = favorites.includes(chat.id);
          const showLabel = chat.groupLabel !== lastGroupLabel;
          lastGroupLabel = chat.groupLabel;

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
                onClick={() => onSelectChat(chat.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectChat(chat.id); } }}
              >
                {renderAvatar(chat, onOpenUserInfo, onOpenGroupInfo)}
                <div className="row-body">
                  <div className="row-top">
                    <div className="row-name">
                      <span>{chat.name}</span>
                      {chat.status && (
                        <span className="row-status" title={chat.status.label}>
                          {chat.status.emoji} {chat.status.label}
                        </span>
                      )}
                    </div>
                    {last && (
                      <div className="row-time">
                        {formatChatListTime(last.created_at)}
                      </div>
                    )}
                  </div>
                  {chat.comment && <div className="row-comment">{chat.comment}</div>}
                  <div className="row-bottom">
                    <div className="row-preview">
                      {last
                        ? (renderTextWithEmoji(last.text || '', customEmoji, `p${chat.id}`)
                          || (last.file_path ? '📷 Фото' : ''))
                        : ''}
                    </div>
                    <div className="row-actions">
                      {unreadCount > 0 && <span className="row-unread">{unreadCount}</span>}
                      <button
                        type="button"
                        className={'icon-btn-ghost star' + (isFavorite ? ' is-fav' : '')}
                        title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                        onClick={(e) => { e.stopPropagation(); onToggleFavorite(chat.id); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
                          <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
                        </svg>
                      </button>
                      {chat.userId && (
                        <button
                          type="button"
                          className="icon-btn-ghost"
                          title="Убрать из списка"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm('Убрать из списка чатов? Переписка сохранится, чат можно будет снова найти в справочнике.')) {
                              onRemoveContact(chat.userId!);
                            }
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </aside>
  );
};

export default ChatList;
