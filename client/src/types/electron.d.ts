export {};

declare global {
  interface Window {
    electronAPI?: {
      platform: string;
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<boolean>;
      // Настройки прокси: сервер во внутренней сети, и часть сетей требует
      // явного прокси в обход системного (см. desktop/src/main.js).
      getProxyState: () => Promise<ProxyState>;
      setProxyState: (patch: Partial<Pick<ProxyState, 'enabled' | 'mode' | 'manualHost' | 'manualPort'>>) => Promise<ProxyState>;
      checkCitProxy: () => Promise<boolean>;
      onProxyStateChanged: (callback: (state: ProxyState) => void) => () => void;
      /** badgeDataUrl — PNG-кружок с числом, рисует рендерер (см. utils/badgeIcon.ts). */
      setUnreadBadge: (count: number, badgeDataUrl?: string) => void;
      focusWindow: () => void;
      /** Раздвинуть окно вправо под правую область. `false` — не потребовалось. */
      ensureWindowWidth?: (width: number) => Promise<boolean>;
      flashWindow: () => void;
      onFocusChange: (callback: (isFocused: boolean) => void) => () => void;
      // Уведомления рисует главный процесс: в рендерере с origin file://
      // Notification API запрещён Chromium (см. utils/desktopNotify.ts).
      showNotification?: (options: { title: string; body: string; tag: string }) => void;
      closeNotification?: (tag: string) => void;
      closeAllNotifications?: () => void;
      onNotificationClick?: (callback: (tag: string) => void) => () => void;
      getAppVersion: () => Promise<string>;
      checkForUpdate: () => void;
      installUpdate: () => void;
      onUpdateState: (callback: (state: UpdateState) => void) => () => void;
    };
  }

  type UpdateState =
    | { status: 'idle' }
    | { status: 'available'; version: string }
    | { status: 'downloading'; percent: number }
    | { status: 'downloaded'; version: string }
    | { status: 'scheduled'; version: string; at: number }
    // Linux: electron-updater не умеет ставить .deb/.tar.gz сам, поэтому
    // готовый пакет только скачивается автоматически, а установка — открытие
    // системным установщиком, что требует явного клика (см. main.js).
    | { status: 'linux-downloading'; percent: number }
    | { status: 'linux-ready'; version: string }
    | { status: 'error'; message: string };

  interface ProxyState {
    enabled: boolean;
    mode: 'manual' | 'cit';
    manualHost: string;
    manualPort: string;
    citPacUrl: string;
    citReachable: boolean;
  }
}
