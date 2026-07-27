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
  getAutoLaunch: () => ipcRenderer.invoke('autostart:get'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  setUnreadBadge: (count) => ipcRenderer.send('unread:set', count),
  focusWindow: () => ipcRenderer.send('window:focus'),
  flashWindow: () => ipcRenderer.send('window:flash'),
  onFocusChange: (callback) => {
    const listener = (_event, isFocused) => callback(isFocused);
    ipcRenderer.on('window:focus-changed', listener);
    return () => ipcRenderer.removeListener('window:focus-changed', listener);
  }
});
