import React, { useEffect, useState } from 'react';
import Avatar from './Avatar';
import { APP_NAME, APP_VERSION } from '../version';
import { applyThemePreference, getThemePreference } from '../utils/theme';
import { describeStatus } from '../utils/statusMeta';
import { CustomEmojiMap, renderTextWithEmoji } from '../utils/customEmoji';

interface AppMenuDrawerProps {
  open: boolean;
  username: string;
  avatarPath: string | null;
  online: boolean;
  statusPreset?: string | null;
  statusCustom?: string | null;
  customEmoji?: CustomEmojiMap;
  favoritesAvailable: boolean;
  onClose: () => void;
  onOpenProfile: () => void;
  onOpenStatus: () => void;
  onOpenChats: () => void;
  onOpenTasks: () => void;
  onCreateGroup: () => void;
  onOpenContacts: () => void;
  onOpenFavorites: () => void;
  onOpenSettings: () => void;
}

const icon = (...paths: string[]) => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {paths.map((d, index) => <path key={index} d={d} />)}
  </svg>
);

function isDarkNow(): boolean {
  const pref = getThemePreference();
  return pref === 'dark' || (
    pref === 'system'
    && typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

const AppMenuDrawer: React.FC<AppMenuDrawerProps> = ({
  open, username, avatarPath, online, statusPreset, statusCustom, customEmoji = {}, favoritesAvailable,
  onClose, onOpenProfile, onOpenStatus, onOpenChats, onOpenTasks, onCreateGroup, onOpenContacts,
  onOpenFavorites, onOpenSettings,
}) => {
  const ownStatus = describeStatus(statusPreset, statusCustom, customEmoji);
  const [dark, setDark] = useState(isDarkNow);
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [soonLabel, setSoonLabel] = useState('');

  useEffect(() => {
    if (!open) return;
    setDark(isDarkNow());
    setSoonLabel('');
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI.getAppVersion().then(setAppVersion).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const run = (action: () => void) => {
    onClose();
    action();
  };

  const planned = (label: string) => setSoonLabel(`${label} — в разработке`);

  const toggleDark = (enabled: boolean) => {
    setDark(enabled);
    applyThemePreference(enabled ? 'dark' : 'light');
  };

  return (
    <div className="app-menu-layer" onMouseDown={onClose}>
      <aside className="app-menu-drawer" aria-label="Меню приложения" onMouseDown={(event) => event.stopPropagation()}>
        <div className="app-menu-profile">
          <button
            type="button"
            className="app-menu-avatar"
            onClick={() => run(onOpenProfile)}
            title="Открыть свой профиль"
            aria-label="Открыть свой профиль"
          >
            <Avatar name={username} avatarPath={avatarPath} size="md" online={online} />
          </button>
          <div className="app-menu-profile-text">
            <div className="app-menu-profile-name">{username}</div>
            <div className="app-menu-profile-meta">
              <span>{ownStatus
                ? renderTextWithEmoji(`${ownStatus.emoji} ${ownStatus.label}`, customEmoji, 'menu-status')
                : (online ? 'В сети' : 'Не в сети')}</span>
            </div>
          </div>
          <button type="button" className="app-menu-close" onClick={onClose} aria-label="Закрыть меню">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="app-menu-items">
          <div className="app-menu-group">
            <button type="button" className="app-menu-item" onClick={() => run(onOpenChats)}>
              <span className="app-menu-item-icon is-chats">{icon('M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z')}</span>
              <span className="app-menu-item-body"><span>Чаты</span></span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => run(onOpenStatus)}>
              <span className="app-menu-item-icon is-status">{icon('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M8 12h8', 'M12 8v8')}</span>
              <span className="app-menu-item-body">
                <span>Статус</span>
                <small>{ownStatus
                  ? renderTextWithEmoji(`${ownStatus.emoji} ${ownStatus.label}`, customEmoji, 'menu-status-action')
                  : 'Сменить'}</small>
              </span>
            </button>
          </div>

          <div className="app-menu-separator" />

          <div className="app-menu-group">
            <button type="button" className="app-menu-item" onClick={() => planned('Закладки')}>
              <span className="app-menu-item-icon is-bookmarks">{icon('M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z')}</span>
              <span className="app-menu-item-body"><span>Закладки</span><small>В разработке</small></span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => run(onOpenTasks)}>
              <span className="app-menu-item-icon is-tasks">{icon('M9 11l2 2 4-4', 'M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z')}</span>
              <span className="app-menu-item-body"><span>Задачи</span></span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => planned('Приложения')}>
              <span className="app-menu-item-icon is-apps">{icon('M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z')}</span>
              <span className="app-menu-item-body"><span>Приложения</span><small>В разработке</small></span>
            </button>
          </div>

          <div className="app-menu-separator" />

          <div className="app-menu-group">
            <button type="button" className="app-menu-item" onClick={() => run(onCreateGroup)}>
              <span className="app-menu-item-icon is-groups">{icon('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M19 8v6', 'M16 11h6')}</span>
              <span className="app-menu-item-body"><span>Создать группу</span></span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => run(onOpenContacts)}>
              <span className="app-menu-item-icon is-contacts">{icon('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75')}</span>
              <span className="app-menu-item-body"><span>Контакты</span></span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => planned('Звонки')}>
              <span className="app-menu-item-icon is-calls">{icon('M4.7 3.8h3.2c.5 0 .92.35 1.03.84l.52 2.32c.1.45-.05.92-.4 1.22L7.3 9.83a14.7 14.7 0 0 0 6.87 6.87l1.67-1.74c.3-.3.76-.46 1.2-.38l2.34.5c.5.1.86.54.86 1.04v3.17c0 .58-.48 1.06-1.06 1.06C10 21.35 2.65 14 2.65 4.86c0-.58.47-1.06 1.05-1.06Z')}</span>
              <span className="app-menu-item-body"><span>Звонки</span><small>В разработке</small></span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => run(onOpenFavorites)} disabled={!favoritesAvailable}>
              <span className="app-menu-item-icon is-favorites">{icon('M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z')}</span>
              <span className="app-menu-item-body"><span>Избранное</span></span>
            </button>
          </div>

          <div className="app-menu-separator" />

          <div className="app-menu-group">
            <button type="button" className="app-menu-item" onClick={() => run(onOpenSettings)}>
              <span className="app-menu-item-icon is-settings">{icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z')}</span>
              <span className="app-menu-item-body"><span>Настройки</span></span>
            </button>

            <label className="app-menu-item app-menu-theme">
              <span className="app-menu-item-icon is-theme">{icon('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z')}</span>
              <span className="app-menu-item-body"><span>Ночной режим</span></span>
              <span className="app-menu-switch">
                <input type="checkbox" checked={dark} onChange={(event) => toggleDark(event.target.checked)} />
                <span className="app-menu-switch-track"><span className="app-menu-switch-thumb" /></span>
              </span>
            </label>
          </div>
        </div>

        <div className="app-menu-footer">
          {soonLabel && <div className="app-menu-soon" role="status">{soonLabel}</div>}
          <div className="app-menu-app-name">{APP_NAME}</div>
          <div className="app-menu-app-version">Версия {appVersion} x64</div>
        </div>
      </aside>
    </div>
  );
};

export default AppMenuDrawer;
