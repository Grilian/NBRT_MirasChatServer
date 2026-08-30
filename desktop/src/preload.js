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

  // Настройки прокси: у сервера внутренний адрес, и на части сетей (без
  // прописанного в ОС прокси) до него не достучаться напрямую — приложение
  // держит свою настройку в обход системной (см. main.js).
  getProxyState: () => ipcRenderer.invoke('proxy:get'),
  setProxyState: (patch) => ipcRenderer.invoke('proxy:set', patch),
  checkCitProxy: () => ipcRenderer.invoke('proxy:check-cit'),
  onProxyStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('proxy:state-changed', listener);
    return () => ipcRenderer.removeListener('proxy:state-changed', listener);
  },
  setUnreadBadge: (count, badgeDataUrl) => ipcRenderer.send('unread:set', count, badgeDataUrl),
  focusWindow: () => ipcRenderer.send('window:focus'),
  /**
   * Раздвинуть окно вправо до нужной ширины, если оно уже, чем требуется.
   * Открытие ветки в узком окне не должно наезжать на переписку — вместо
   * этого приложение выходит из узкого состояния (см. layoutMode.ts).
   */
  ensureWindowWidth: (width) => ipcRenderer.invoke('window:ensure-width', width),
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

  // Скачивание файла из переписки: сохраняет в «Загрузки» и возвращает путь.
  // Делает это главный процесс — в рендерере ссылка увела бы во внешний
  // браузер (см. main.js).
  downloadFile: (url, filename) => ipcRenderer.invoke('file:download', url, filename),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),

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
