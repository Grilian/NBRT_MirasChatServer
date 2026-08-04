import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { ThemePreference, applyThemePreference, getThemePreference } from '../utils/theme';
import {
  DURATION_OPTIONS,
  NotificationPrefs,
  getNotificationPrefs,
  saveNotificationPrefs,
} from '../utils/notificationPrefs';
import { UiPrefs, getUiPrefs, saveUiPrefs } from '../utils/uiPrefs';
import { desktopNotificationPermission, ensureDesktopNotificationPermission } from '../utils/desktopNotify';
import { isNativeMobile } from '../utils/mobileNotify';
import { playIncomingSound } from '../utils/sound';
import { formatMoscowDateTime } from '../utils/time';
import { MobileUpdateInfo, checkMobileUpdate, mobileVersionName, openMobileUpdate } from '../utils/mobileUpdate';
import { APP_VERSION, BUILT_AT } from '../version';
import AndroidQrModal from './AndroidQrModal';

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
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [mobileUpdate, setMobileUpdate] = useState<MobileUpdateInfo | null>(null);
  const [notify, setNotify] = useState<NotificationPrefs>(getNotificationPrefs);
  const [ui, setUi] = useState<UiPrefs>(getUiPrefs);
  const [systemPermission, setSystemPermission] = useState(desktopNotificationPermission());
  const [qrOpen, setQrOpen] = useState(false);

  const handleThemeChange = (value: ThemePreference) => {
    setTheme(value);
    applyThemePreference(value);
  };

  // Сохраняем сразу при изменении — отдельной кнопки «Применить» тут нет,
  // как и в остальных настройках приложения.
  const updateNotify = (patch: Partial<NotificationPrefs>) => {
    const next = { ...notify, ...patch };
    setNotify(next);
    saveNotificationPrefs(next);
  };

  const updateUi = (patch: Partial<UiPrefs>) => {
    const next = { ...ui, ...patch };
    setUi(next);
    saveUiPrefs(next);
  };

  const handleSystemToggle = async (checked: boolean) => {
    // Включение системных уведомлений без выданного разрешения ничего бы не
    // дало — переключатель встал бы в «вкл», а уведомлений всё равно не было.
    if (checked) {
      await ensureDesktopNotificationPermission();
      setSystemPermission(desktopNotificationPermission());
    }
    updateNotify({ system: checked });
  };

  useEffect(() => {
    if (isElectron) {
      window.electronAPI!.getAutoLaunch().then(setAutoLaunch);
      window.electronAPI!.getAppVersion().then(setAppVersion);
    }
  }, []);

  // На Android номер версии и проверка обновления берутся из самого пакета
  // и манифеста на сервере — по той же причине, что и в десктопе: строка
  // «доступна 1.3.2» бесполезна, пока не видно, что стоит сейчас.
  useEffect(() => {
    mobileVersionName().then((version) => { if (version) setAppVersion(version); });
    checkMobileUpdate().then(setMobileUpdate);
  }, []);

  // Состояние автообновления приходит из main-процесса. Проверку запускаем и
  // при открытии настроек: человек, который сюда зашёл, скорее всего как раз
  // и хочет узнать, есть ли новая версия, а фоновая проверка идёт раз в
  // несколько часов.
  useEffect(() => {
    if (!isElectron) return;
    const unsubscribe = window.electronAPI!.onUpdateState(setUpdate);
    window.electronAPI!.checkForUpdate();
    return unsubscribe;
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

        {/* Статус переехал в профиль: это часть того, что человек о себе
            сообщает, а не настройка приложения — и менять его логично там же,
            где имя, должность и аватар. */}

        <div className="settings-section-title">Список чатов</div>
        <div className="settings-group">
          <div className="settings-row static">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            <span className="label">Группировать по отделам</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={ui.groupContacts}
                onChange={(e) => updateUi({ groupContacts: e.target.checked })}
              />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
          </div>
          <div className="settings-hint">
            Выключено — чаты идут по свежести переписки. Включено — разбиты на разделы по отделам.
          </div>
        </div>

        <div className="settings-section-title">Уведомления</div>
        <div className="settings-group">
          <div className="settings-row static">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
            <span className="label">Уведомления о сообщениях</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={notify.enabled}
                onChange={(e) => updateNotify({ enabled: e.target.checked })}
              />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
          </div>

          <div className="settings-row static">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M19.1 4.9a10 10 0 0 1 0 14.2M15.5 8.5a5 5 0 0 1 0 7" /></svg>
            <span className="label">Звук</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={notify.sound}
                disabled={!notify.enabled}
                onChange={(e) => {
                  updateNotify({ sound: e.target.checked });
                  if (e.target.checked) playIncomingSound(); // сразу слышно, какой он
                }}
              />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
          </div>

          {!isNativeMobile && (
            <div className="settings-row static">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></svg>
              <span className="label">Системные уведомления</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={notify.system}
                  disabled={!notify.enabled}
                  onChange={(e) => handleSystemToggle(e.target.checked)}
                />
                <span className="switch-track"><span className="switch-thumb" /></span>
              </label>
            </div>
          )}

          {!isNativeMobile && notify.enabled && notify.system && systemPermission === 'denied' && (
            <div className="settings-note is-warning">
              Системные уведомления запрещены в настройках {isElectron ? 'Windows' : 'браузера'} — разрешите их там,
              иначе за пределами окна приложения уведомления показываться не будут. Всплывающие уведомления
              внутри приложения работают в любом случае.
            </div>
          )}

          <div className="settings-row static">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <span className="label">Показывать уведомление</span>
            <select
              className="settings-select"
              value={notify.durationMs}
              disabled={!notify.enabled}
              onChange={(e) => updateNotify({ durationMs: Number(e.target.value) })}
            >
              {DURATION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-note">
            Уведомление висит указанное время, а при наведении курсора таймер останавливается — чтобы
            сообщение не пропало, пока вас нет на месте.
          </div>
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

              {/* Ни «Скачать», ни «Установить» тут нет: обновление идёт само.
                  Строки ниже — не действия, а отчёт о том, что происходит,
                  чтобы скачивание на фоне не выглядело чем-то непрошеным. */}
              {(update.status === 'available' || update.status === 'downloading') && (
                <div className="settings-row static">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" /></svg>
                  <span className="label">Загрузка обновления</span>
                  <span className="value">{update.status === 'downloading' ? `${update.percent}%` : '…'}</span>
                </div>
              )}

              {/* Установку назначил супер-админ. Кнопки «Перезапустить» тут
                  намеренно нет: она обошла бы назначенный час, ради которого
                  расписание и заводили. */}
              {update.status === 'scheduled' && (
                <div className="settings-row static">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  <span className="label">Обновление {update.version} установится</span>
                  <span className="value">{formatMoscowDateTime(update.at)}</span>
                </div>
              )}

              {/* Единственная кнопка во всей механике, и та необязательная:
                  обновление и так встанет при закрытии приложения. Она для
                  того, кто увидел строку и хочет получить новую версию сейчас. */}
              {update.status === 'downloaded' && (
                <button type="button" className="settings-row" onClick={() => window.electronAPI!.installUpdate()}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                  <span className="label">Обновление {update.version} встанет при закрытии</span>
                  <span className="value is-action">Перезапустить</span>
                </button>
              )}
            </div>
          </>
        )}

        {/* На Android обновление молча поставить нельзя: система не даёт
            приложениям устанавливать пакеты без своего диалога. Поэтому здесь,
            в отличие от десктопа, кнопка обязательна — она открывает ссылку на
            APK, дальше скачивание и установку ведёт сам Android. */}
        {mobileUpdate && (
          <>
            <div className="settings-section-title">Приложение</div>
            <div className="settings-group">
              <button type="button" className="settings-row" onClick={() => openMobileUpdate(mobileUpdate.url)}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" /></svg>
                <span className="label">Доступна версия {mobileUpdate.versionName}</span>
                <span className="value is-action">Обновить</span>
              </button>
            </div>
          </>
        )}

        {/* На самом телефоне сканировать QR своего же приложения незачем —
            кнопка для тех, кто ставит Android-версию с компьютера или веба. */}
        {!isNativeMobile && (
          <>
            <div className="settings-section-title">Android-приложение</div>
            <div className="settings-group">
              <button type="button" className="settings-row" onClick={() => setQrOpen(true)}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h-3zM21 14v3M14 21h3M21 21v-1" /></svg>
                <span className="label">QR-код для установки на телефон</span>
                <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
          </>
        )}
        {qrOpen && <AndroidQrModal onClose={() => setQrOpen(false)} />}

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

        {/* В десктопе показываем номер версии: он совпадает с тем, что пишет
            строка обновления, и человеку есть с чем сравнить. Хэш сборки
            остаётся в вебе — там номера версии просто нет, а знать, какой
            коммит раскатан, всё равно нужно (см. README, проверка деплоя). */}
        <div className="app-version">MirasChat {appVersion ?? APP_VERSION} · {BUILT_AT}</div>
      </div>
    </div>
  );
};

export default SettingsPanel;
