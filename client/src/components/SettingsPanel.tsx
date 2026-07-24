import React, { useEffect, useState } from 'react';
import Avatar from './Avatar';
import { ThemePreference, applyThemePreference, getThemePreference } from '../utils/theme';
import { APP_VERSION, BUILT_AT } from '../version';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

interface SettingsPanelProps {
  username: string;
  avatarPath: string | null;
  onClose: () => void;
  onOpenProfile: () => void;
  onDeleteAccount: () => void;
  onLogout: () => void;
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Системная' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  username, avatarPath, onClose, onOpenProfile, onDeleteAccount, onLogout
}) => {
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const [autoLaunch, setAutoLaunch] = useState(false);

  const handleThemeChange = (value: ThemePreference) => {
    setTheme(value);
    applyThemePreference(value);
  };

  useEffect(() => {
    if (isElectron) {
      window.electronAPI!.getAutoLaunch().then(setAutoLaunch);
    }
  }, []);

  const handleAutoLaunchChange = (checked: boolean) => {
    setAutoLaunch(checked); // сразу отражаем в UI, не дожидаясь ответа ОС
    window.electronAPI!.setAutoLaunch(checked).then(setAutoLaunch);
  };

  return (
    <div className="settings-panel">
      <div className="conv-head">
        <button type="button" className="icon-btn back-btn" onClick={onClose} aria-label="Назад" style={{ display: 'inline-flex' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="conv-title"><div className="settings-title">Настройки</div></div>
      </div>

      <div className="settings-body">
        <div className="profile-card">
          <Avatar name={username} avatarPath={avatarPath} />
          <div className="name">{username}</div>
        </div>

        <div className="settings-section-title">Оформление</div>
        <div className="settings-group">
          <div className="settings-row static">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            <span className="label">Тема</span>
          </div>
          <div className="settings-inline-control">
            <div className="segmented">
              {THEME_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className={theme === opt.value ? 'is-active' : ''}
                  onClick={() => handleThemeChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {isElectron && (
          <>
            <div className="settings-section-title">Приложение</div>
            <div className="settings-group">
              <div className="settings-row static">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v6" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>
                <span className="label">Добавить в автозагрузку</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autoLaunch}
                    onChange={(e) => handleAutoLaunchChange(e.target.checked)}
                  />
                  <span className="switch-track"><span className="switch-thumb" /></span>
                </label>
              </div>
            </div>
          </>
        )}

        <div className="settings-section-title">Аккаунт</div>
        <div className="settings-group">
          <button type="button" className="settings-row" onClick={onOpenProfile}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg>
            <span className="label">Редактировать профиль</span>
            <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
          </button>
          <button type="button" className="settings-row danger" onClick={onDeleteAccount}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            <span className="label">Удалить аккаунт</span>
          </button>
        </div>

        <div className="settings-group">
          <button type="button" className="settings-row" onClick={onLogout}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></svg>
            <span className="label">Выйти</span>
          </button>
        </div>

        <div className="app-version">MirasChat {APP_VERSION} · {BUILT_AT}</div>
      </div>
    </div>
  );
};

export default SettingsPanel;
