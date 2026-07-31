const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getAutoLaunch: () => ipcRenderer.invoke('autostart:get'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  setUnreadBadge: (count) => ipcRenderer.send('unread:set', count),
  focusWindow: () => ipcRenderer.send('window:focus'),
  flashWindow: () => ipcRenderer.send('window:flash'),
  onFocusChange: (callback) => {
    const listener = (_event, isFocused) => callback(isFocused);
    ipcRenderer.on('window:focus-changed', listener);
    return () => ipcRenderer.removeListener('window:focus-changed', listener);
  },

  // Уведомления показывает главный процесс: у рендерера origin file://, а там
  // Chromium запрещает Notification API наглухо (см. комментарий в main.js).
  showNotification: (options) => ipcRenderer.send('notify:show', options),
  closeNotification: (tag) => ipcRenderer.send('notify:close', tag),
  closeAllNotifications: () => ipcRenderer.send('notify:close-all'),
  onNotificationClick: (callback) => {
    const listener = (_event, tag) => callback(tag);
    ipcRenderer.on('notification:clicked', listener);
    return () => ipcRenderer.removeListener('notification:clicked', listener);
  },

  // Автообновление идёт само: скачивается фоном, ставится при выходе. Наружу
  // отдаём только состояние для показа и «Перезапустить» для нетерпеливых.
  checkForUpdate: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  }
});
