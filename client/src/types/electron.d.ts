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
    | { status: 'error'; message: string };
}
