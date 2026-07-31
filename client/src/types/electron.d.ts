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
      setUnreadBadge: (count: number) => void;
      focusWindow: () => void;
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
    | { status: 'error'; message: string };
}
