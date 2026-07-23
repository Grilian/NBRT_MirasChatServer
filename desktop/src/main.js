const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_STATE = { width: 1200, height: 800, x: undefined, y: undefined, isMaximized: false };
const MIN_WIDTH = 860;
const MIN_HEIGHT = 560;

let mainWindow = null;
let tray = null;
let isQuitting = false;

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  const bounds = isMaximized ? loadWindowState() : win.getBounds();
  try {
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized
      })
    );
  } catch {
    // не критично, окно просто откроется со значениями по умолчанию в след. раз
  }
}

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: '#101d17',
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(RENDERER_INDEX);

  mainWindow.once('ready-to-show', () => {
    if (state.isMaximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    } else {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createTray() {
  tray = new Tray(path.join(ASSETS_DIR, 'tray.png'));
  tray.setToolTip('MirasChat');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Открыть MirasChat',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// Красная точка на иконке в трее + оверлей поверх значка в таскбаре, пока
// есть непрочитанное сообщение — состояние присылает рендерер по IPC.
function setUnreadBadge(hasUnread) {
  if (tray) {
    tray.setImage(path.join(ASSETS_DIR, hasUnread ? 'tray-unread.png' : 'tray.png'));
  }
  if (mainWindow) {
    mainWindow.setOverlayIcon(
      hasUnread ? nativeImage.createFromPath(path.join(ASSETS_DIR, 'overlay-unread.png')) : null,
      hasUnread ? 'Есть непрочитанные сообщения' : ''
    );
  }
}

function createAppMenu() {
  const template = [
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить' },
        { role: 'forceReload', label: 'Обновить (полностью)' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Сбросить масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полноэкранный режим' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        {
          label: 'Закрыть',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    }
  ];

  if (isDev) {
    template[0].submenu.push({ type: 'separator' }, { role: 'toggleDevTools', label: 'Инструменты разработчика' });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createAppMenu();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow.show();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.on('unread:set', (event, hasUnread) => setUnreadBadge(!!hasUnread));

// Клик по всплывающему уведомлению — окно может быть свёрнуто в трей
// (mainWindow.hide()), обычного window.focus() из рендерера для этого мало.
ipcMain.on('window:focus', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
