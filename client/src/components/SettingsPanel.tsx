import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import api from '../api/client';
import { applyChatWallpaper } from '../utils/chatWallpaper';
import { resolveUploadUrl } from '../utils/uploads';
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
import { APP_NAME, APP_VERSION, BUILT_AT } from '../version';
import AndroidQrModal from './AndroidQrModal';
import WebDownloadLinks from './WebDownloadLinks';

const isElectronEnv = () => typeof window !== 'undefined' && !!window.electronAPI;

interface SettingsPanelProps {
  username: string;
  avatarPath: string | null;
  onClose: () => void;
  onOpenProfile: () => void;
  onDeleteAccount: () => void;
  onLogout: () => void;
  /** В модалке десктопа закрываем крестиком; полноэкранный мобильный раздел — стрелкой назад. */
  closeMode?: 'back' | 'close';
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Системная' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  username, avatarPath, onClose, onOpenProfile, onDeleteAccount, onLogout, closeMode = 'back'
}) => {
  // Раньше это было константой уровня модуля — на практике неотличимо (объект
  // window.electronAPI ставит preload ещё до старта рендерера, и за время
  // жизни приложения он не появляется и не исчезает), а для тестов, где
  // window.electronAPI ставится/убирается перед каждым сценарием, константа
  // модуля осталась бы навсегда таким, каким увидела его при самом первом
  // импорте файла.
  const isElectron = isElectronEnv();
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [mobileUpdate, setMobileUpdate] = useState<MobileUpdateInfo | null>(null);
  const [notify, setNotify] = useState<NotificationPrefs>(getNotificationPrefs);
  const [ui, setUi] = useState<UiPrefs>(getUiPrefs);
  const [systemPermission, setSystemPermission] = useState(desktopNotificationPermission());
  const [qrOpen, setQrOpen] = useState(false);
  const [proxy, setProxy] = useState<ProxyState | null>(null);
  const [proxyManualHost, setProxyManualHost] = useState('');
  const [proxyManualPort, setProxyManualPort] = useState('');
  const [proxyCitUsername, setProxyCitUsername] = useState('');
  const [proxyCitPassword, setProxyCitPassword] = useState('');
  const [proxySaving, setProxySaving] = useState(false);

  // Обои под лентой. Путь держим в localStorage, потому что применяет их не
  // React, а переменные CSS (см. utils/chatWallpaper.ts), и панели нужно лишь
  // знать, показывать ли кнопку «Убрать».
  const [wallpaperPath, setWallpaperPath] = useState<string | null>(
    localStorage.getItem('chatBackgroundPath') || null
  );
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [wallpaperError, setWallpaperError] = useState('');
  const wallpaperInputRef = useRef<HTMLInputElement | null>(null);
  const wallpaperUrl = resolveUploadUrl(wallpaperPath);

  const rememberWallpaper = (path: string | null) => {
    setWallpaperPath(path);
    localStorage.setItem('chatBackgroundPath', path || '');
    // Применяем сразу: фон должен смениться под открытой перепиской, а не
    // после перезахода.
    applyChatWallpaper(path);
  };

  const handleWallpaperPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Значение поля сбрасываем всегда: без этого повторный выбор того же файла
    // не вызывает change, и «Заменить» после ошибки не срабатывает.
    e.target.value = '';
    if (!file) return;

    setWallpaperBusy(true);
    setWallpaperError('');
    try {
      const form = new FormData();
      form.append('background', file);
      const { data } = await api.post('/users/me/chat-background', form);
      rememberWallpaper(data.chat_background_path || null);
    } catch (err: any) {
      setWallpaperError(err.response?.data?.error || 'Не удалось загрузить изображение');
    } finally {
      setWallpaperBusy(false);
    }
  };

  const handleWallpaperRemove = async () => {
    setWallpaperBusy(true);
    setWallpaperError('');
    try {
      await api.delete('/users/me/chat-background');
      rememberWallpaper(null);
    } catch {
      setWallpaperError('Не удалось убрать фон');
    } finally {
      setWallpaperBusy(false);
    }
  };

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
  }, [isElectron]);

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
  }, [isElectron]);

  const handleAutoLaunchChange = (checked: boolean) => {
    setAutoLaunch(checked); // сразу отражаем в UI, не дожидаясь ответа ОС
    window.electronAPI!.setAutoLaunch(checked).then(setAutoLaunch);
  };

  // Прокси нужен только там, где до внутреннего сервера не достучаться
  // напрямую — вне сети конторы, без прописанного в системе прокси. Состояние
  // и применение живут в main-процессе (см. desktop/src/main.js): панель
  // здесь только показывает его и просит изменить.
  useEffect(() => {
    if (!isElectron) return;
    // Начальную загрузку синхронизируем полностью, включая поля ввода. А вот
    // push из main-процесса (onProxyStateChanged) теперь прилетает не только
    // при автовключении по IP, но и при каждой попытке логина на прокси —
    // если в этот момент человек как раз печатает логин или пароль, обычная
    // синхронизация затёрла бы набранный текст. Поэтому push обновляет
    // только то, что показывается только для чтения (доступность, статус
    // авторизации), а поля ввода не трогает.
    window.electronAPI!.getProxyState().then((state) => {
      setProxy(state);
      setProxyManualHost(state.manualHost);
      setProxyManualPort(state.manualPort);
      setProxyCitUsername(state.citUsername);
    });
    return window.electronAPI!.onProxyStateChanged?.((state) => {
      setProxy((prev) => (prev ? { ...prev, ...state } : state));
    });
  }, [isElectron]);

  // Пока открыт раздел с прокси, доступность и статус авторизации
  // перепроверяем сами: человек мог как раз в этот момент переключиться на
  // нужный Wi-Fi или прокси мог принять данные после повторной попытки, и
  // подсказка должна обновиться сама, а не только после перезахода в раздел.
  useEffect(() => {
    if (!isElectron || (proxy?.mode !== 'cit' && proxy?.mode !== 'system')) return;
    const interval = setInterval(() => {
      window.electronAPI!.checkCitProxy().then((citReachable) => {
        setProxy((prev) => (prev ? { ...prev, citReachable } : prev));
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [isElectron, proxy?.mode]);

  const updateProxy = (patch: Partial<Pick<ProxyState, 'enabled' | 'mode' | 'manualHost' | 'manualPort' | 'citUsername'>> & { citPassword?: string }) => {
    setProxySaving(true);
    window.electronAPI!.setProxyState(patch).then((state) => {
      setProxy(state);
      setProxyManualHost(state.manualHost);
      setProxyManualPort(state.manualPort);
      setProxyCitUsername(state.citUsername);
      setProxyCitPassword(''); // поле пароля никогда не подставляем обратно — только факт, что он сохранён
      setProxySaving(false);
    });
  };

  const saveProxyManual = (e: React.FormEvent) => {
    e.preventDefault();
    updateProxy({ manualHost: proxyManualHost, manualPort: proxyManualPort });
  };

  const saveProxyCitCredentials = (e: React.FormEvent) => {
    e.preventDefault();
    // Пустое поле пароля = «не менять сохранённый». Явная очистка — кнопкой
    // «Убрать» ниже, которая шлёт citPassword: '' отдельно.
    const patch: Partial<Pick<ProxyState, 'citUsername'>> & { citPassword?: string } = { citUsername: proxyCitUsername };
    if (proxyCitPassword) patch.citPassword = proxyCitPassword;
    updateProxy(patch);
  };

  const clearProxyCitPassword = () => {
    updateProxy({ citPassword: '' });
  };

  return (
    <div className="settings-panel">
      <div className="conv-head">
        {closeMode === 'back' && (
          <button type="button" className="icon-btn back-btn" onClick={onClose} aria-label="Назад" style={{ display: 'inline-flex' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
          </button>
        )}
        <div className="conv-title"><div className="settings-title">Настройки</div></div>
        {closeMode === 'close' && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        )}
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

        <div className="settings-section-title">Переписка</div>
        <div className="settings-group">
          <div className="settings-row static">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01M15 9h.01" /></svg>
            <span className="label">Анимированные смайлики</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={ui.animatedEmoji}
                onChange={(e) => updateUi({ animatedEmoji: e.target.checked })}
              />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
          </div>
          <div className="settings-hint">
            Выключено — смайлики в переписке остаются неподвижными. Настройка личная: у остальных
            анимация продолжит работать.
          </div>
        </div>

        <div className="settings-section-title">Фон переписки</div>
        <div className="settings-group">
          <div className="settings-row static settings-wallpaper">
            <div
              className={'settings-wallpaper-preview' + (wallpaperUrl ? ' has-image' : '')}
              style={wallpaperUrl ? { backgroundImage: `url("${wallpaperUrl}")` } : undefined}
              aria-hidden="true"
            />
            <div className="settings-wallpaper-actions">
              {/* Поле файла спрятано за кнопкой: системное оформление input[type=file]
                  не поддаётся стилям и выбивалось бы из списка настроек. */}
              <input
                ref={wallpaperInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={handleWallpaperPick}
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => wallpaperInputRef.current?.click()}
                disabled={wallpaperBusy}
              >
                {wallpaperBusy ? 'Загрузка…' : wallpaperUrl ? 'Заменить' : 'Выбрать изображение'}
              </button>
              {wallpaperUrl && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleWallpaperRemove}
                  disabled={wallpaperBusy}
                >
                  Убрать
                </button>
              )}
            </div>
          </div>
          {wallpaperError && <div className="settings-hint form-error">{wallpaperError}</div>}
          <div className="settings-hint">
            Один фон на все чаты сразу. Лучше всего подходит вертикальное изображение — лента
            сообщений выше своей ширины. Сервер сжимает картинку, поэтому исходник может быть
            любого размера.
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

              {/* Linux: electron-updater не умеет тихо поставить .deb/.tar.gz,
                  поэтому пакет только скачивается сам, а установка требует
                  клика — откроется системный установщик, как при двойном
                  клике по скачанному .deb. */}
              {update.status === 'linux-downloading' && (
                <div className="settings-row static">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" /></svg>
                  <span className="label">Загрузка обновления</span>
                  <span className="value">{update.percent}%</span>
                </div>
              )}
              {update.status === 'linux-ready' && (
                <button type="button" className="settings-row" onClick={() => window.electronAPI!.installUpdate()}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                  <span className="label">Обновление {update.version} скачано</span>
                  <span className="value is-action">Установить</span>
                </button>
              )}
            </div>
          </>
        )}

        {/* Сервер во внутренней сети конторы: без прокси на некоторых сетях
            (домашний интернет, гостевой Wi-Fi, VPN) чат просто не подключается,
            и без этой настройки понять почему было неоткуда. */}
        {isElectron && proxy && (
          <>
            <div className="settings-section-title">Прокси</div>
            <div className="settings-group">
              <div className="settings-row static">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>
                <span className="label">Использовать прокси</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={proxy.enabled}
                    disabled={proxySaving}
                    onChange={(e) => updateProxy({ enabled: e.target.checked })}
                  />
                  <span className="switch-track"><span className="switch-thumb" /></span>
                </label>
              </div>

              {proxy.enabled && (
                <>
                  <div className="settings-inline-control">
                    <div className="segmented">
                      <button
                        type="button"
                        className={proxy.mode === 'system' ? 'is-active' : ''}
                        disabled={proxySaving}
                        onClick={() => updateProxy({ mode: 'system' })}
                      >
                        Системный
                      </button>
                      <button
                        type="button"
                        className={proxy.mode === 'manual' ? 'is-active' : ''}
                        disabled={proxySaving}
                        onClick={() => updateProxy({ mode: 'manual' })}
                      >
                        Вручную
                      </button>
                      <button
                        type="button"
                        className={proxy.mode === 'cit' ? 'is-active' : ''}
                        disabled={proxySaving}
                        onClick={() => updateProxy({ mode: 'cit' })}
                      >
                        ЦИТ
                      </button>
                    </div>
                  </div>

                  {proxy.mode === 'system' && (
                    <div className="field">
                      <label>Системный прокси</label>
                      <div className="field-readonly">
                        Используются настройки сети из самой ОС
                      </div>
                      <div className="field-hint">
                        То же самое, чем в этой ситуации и так уже пользуется браузер. Подходит,
                        если прокси уже настроен в сетевых параметрах системы.
                      </div>
                    </div>
                  )}

                  {proxy.mode === 'manual' && (
                    <form className="field proxy-manual-fields" onSubmit={saveProxyManual}>
                      <label>Адрес и порт</label>
                      <div className="proxy-manual-inputs">
                        <input
                          type="text"
                          value={proxyManualHost}
                          onChange={(e) => setProxyManualHost(e.target.value)}
                          placeholder="proxy.example.ru"
                        />
                        <input
                          type="text"
                          className="proxy-manual-port"
                          value={proxyManualPort}
                          onChange={(e) => setProxyManualPort(e.target.value)}
                          placeholder="8080"
                        />
                      </div>
                      <button type="submit" className="btn-primary" disabled={proxySaving || !proxyManualHost.trim()}>
                        Сохранить
                      </button>
                    </form>
                  )}

                  {proxy.mode === 'cit' && (
                    <div className="field">
                      <label>Автонастройка ЦИТ</label>
                      <div className={'field-readonly' + (proxy.citReachable ? '' : ' is-muted')}>
                        PAC ЦИТ — i.tatar.ru:8080
                      </div>
                      {!proxy.citReachable && (
                        <div className="field-hint">Не настроен — подключите Wi-Fi для настройки</div>
                      )}
                    </div>
                  )}

                  {/* Логин и пароль относятся к самому прокси-серверу, а не к
                      способу, которым его нашли — нужны что в «Системном»
                      режиме (браузер в этой же сети их тоже спрашивает), что
                      в «ЦИТ». В режиме «Вручную» человек мог указать другой
                      сервер без авторизации, поэтому там их не показываем. */}
                  {(proxy.mode === 'cit' || proxy.mode === 'system') && (
                    <form className="field proxy-manual-fields" onSubmit={saveProxyCitCredentials}>
                      <label>Логин и пароль прокси</label>
                      <div className="proxy-manual-inputs">
                        <input
                          type="text"
                          value={proxyCitUsername}
                          onChange={(e) => setProxyCitUsername(e.target.value)}
                          placeholder="Домен\логин, напр. govtatar\ivanov"
                          autoComplete="username"
                        />
                        <input
                          type="password"
                          value={proxyCitPassword}
                          onChange={(e) => setProxyCitPassword(e.target.value)}
                          placeholder={proxy.citPasswordSet ? 'Пароль сохранён — введите новый, чтобы изменить' : 'Пароль'}
                          autoComplete="current-password"
                        />
                      </div>
                      <div className="proxy-manual-actions">
                        <button type="submit" className="btn-primary" disabled={proxySaving}>
                          Сохранить
                        </button>
                        {proxy.citPasswordSet && (
                          <button type="button" className="btn-plain" disabled={proxySaving} onClick={clearProxyCitPassword}>
                            Убрать пароль
                          </button>
                        )}
                      </div>
                      {proxy.citAuthStatus === 'rejected' && (
                        <div className="field-hint is-warning">
                          Прокси не принял логин или пароль. Проверьте, что домен указан через
                          обратный слэш перед именем (govtatar\ivanov), и попробуйте снова.
                        </div>
                      )}
                      {proxy.citAuthStatus === 'no-credentials' && (
                        <div className="field-hint">
                          Прокси запросил авторизацию, а логин и пароль ещё не заполнены —
                          заполните их выше.
                        </div>
                      )}
                    </form>
                  )}
                </>
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

        {/* После обновления навигации шапка списка чатов на широком экране
            скрыта целиком, а вместе с ней случайно исчезли и ссылки на
            дистрибутивы. В веб-версии держим их в постоянном явном месте —
            настройках приложения. Electron и Android обновляются своими
            механизмами и этот блок не получают. */}
        {!isElectron && !isNativeMobile && (
          <>
            <div className="settings-section-title">Приложение</div>
            <div className="settings-group web-distributions-group">
              <WebDownloadLinks variant="settings" />
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
        <div className="app-version">{APP_NAME} {appVersion ?? APP_VERSION} · {BUILT_AT}</div>
      </div>
    </div>
  );
};

export default SettingsPanel;
