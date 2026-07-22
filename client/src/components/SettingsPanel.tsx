import React, { useState } from 'react';
import { initialsForName, colorForName } from '../utils/avatar';
import { ThemePreference, applyThemePreference, getThemePreference } from '../utils/theme';

interface SettingsPanelProps {
  username: string;
  isMirasAccount: boolean;
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
  username, isMirasAccount, onClose, onOpenProfile, onDeleteAccount, onLogout
}) => {
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());

  const handleThemeChange = (value: ThemePreference) => {
    setTheme(value);
    applyThemePreference(value);
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
          <div className="avatar" style={{ background: colorForName(username) }}>{initialsForName(username)}</div>
          <div className="name">{username}</div>
          {isMirasAccount && <div className="sub">Вход через МИРАС</div>}
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

        <div className="settings-section-title">Аккаунт</div>
        <div className="settings-group">
          {isMirasAccount ? (
            <div className="settings-note">Профиль и пароль этого аккаунта управляются на сервере МИРАС.</div>
          ) : (
            <button type="button" className="settings-row" onClick={onOpenProfile}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg>
              <span className="label">Редактировать профиль</span>
              <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          )}
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
      </div>
    </div>
  );
};

export default SettingsPanel;
