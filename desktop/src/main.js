const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// Windows связывает всплывающие уведомления с AppUserModelID приложения.
// Без явной установки у незапакованного/неправильно зарегистрированного
// приложения он не совпадает с тем, что прописал установщик, и система
// молча выбрасывает уведомления — new Notification() в рендерере отрабатывает
// без ошибок, а на экране не появляется ничего. Значение должно совпадать с
// build.appId в package.json.
const APP_USER_MODEL_ID = 'ru.miras.mirasChat';
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

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

  // Как только человек вернулся к окну — прекращаем мигать кнопкой в
  // панели задач и сообщаем рендереру, что можно отмечать открытый чат
  // прочитанным. Веб-события focus/blur внутри Electron приходят не всегда
  // (например, при показе окна из трея), поэтому дублируем их из main.
  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false);
    mainWindow.webContents.send('window:focus-changed', true);
  });
  mainWindow.on('blur', () => mainWindow.webContents.send('window:focus-changed', false));
  mainWindow.on('hide', () => mainWindow.webContents.send('window:focus-changed', false));
  mainWindow.on('show', () => {
    if (mainWindow.isFocused()) mainWindow.webContents.send('window:focus-changed', true);
  });

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
// Раньше сюда приходил голый boolean; теперь ещё и количество, чтобы точное
// число было видно в подсказке трея, не открывая окно.
function setUnreadBadge(count) {
  const hasUnread = count > 0;

  if (tray) {
    tray.setImage(path.join(ASSETS_DIR, hasUnread ? 'tray-unread.png' : 'tray.png'));
    tray.setToolTip(hasUnread ? `MirasChat — непрочитанных: ${count}` : 'MirasChat');
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(
      hasUnread ? nativeImage.createFromPath(path.join(ASSETS_DIR, 'overlay-unread.png')) : null,
      hasUnread ? `Непрочитанных сообщений: ${count}` : ''
    );
  }
}

// Мигание кнопки в панели задач — если окно свёрнуто или спрятано в трей,
// это единственный способ обратить на себя внимание, кроме самого
// уведомления, которое человек мог и пропустить. Windows мигает до тех пор,
// пока окно не получит фокус.
function flashOnNewMessage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isFocused()) return;
  mainWindow.flashFrame(true);
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
ipcMain.on('unread:set', (event, count) => setUnreadBadge(Number(count) || 0));
ipcMain.on('window:flash', () => flashOnNewMessage());

// Клик по всплывающему уведомлению — окно может быть свёрнуто в трей
// (mainWindow.hide()), обычного window.focus() из рендерера для этого мало.
ipcMain.on('window:focus', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
