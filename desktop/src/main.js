const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
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
const APP_STATE_PATH = path.join(app.getPath('userData'), 'app-state.json');

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

function loadAppState() {
  try {
    return JSON.parse(fs.readFileSync(APP_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveAppState(patch) {
  try {
    fs.writeFileSync(APP_STATE_PATH, JSON.stringify({ ...loadAppState(), ...patch }));
  } catch {
    // не критично: в худшем случае автозагрузку включим ещё раз
  }
}

// Мессенджер без автозагрузки бесполезен: пропущенные сообщения человек
// увидит, только когда сам вспомнит открыть приложение. Поэтому после
// установки включаем её сами — раньше переключатель в настройках стоял
// выключенным, и каждый новый сотрудник должен был найти его руками.
//
// Ровно один раз: отметку о том, что мы уже вмешивались, храним отдельно от
// самой настройки Windows. Иначе выключенная пользователем автозагрузка
// включалась бы обратно при каждом запуске.
function applyDefaultAutoLaunch() {
  // В dev-режиме прописался бы путь до electron.exe из node_modules — мусор
  // в автозагрузке рабочей машины, который потом искать вручную.
  if (isDev) return;
  if (loadAppState().autoLaunchInitialized) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true });
  } catch (e) {
    console.error('Не удалось включить автозагрузку:', e.message);
  }
  saveAppState({ autoLaunchInitialized: true });
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
    applyDefaultAutoLaunch();
    createAppMenu();
    createWindow();
    createTray();

    // Первую проверку откладываем: на старте приложение и так занято
    // загрузкой клиента и установкой сокета, а обновление никуда не убежит.
    setTimeout(checkForUpdates, 15000);
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);

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

// ===== Автообновление =====
//
// Раздача — обычная статика на нашем же сервере (provider generic в
// package.json). Сборка dist:win кладёт рядом с установщиком latest.yml и
// .blockmap; их надо залить вместе с .exe, иначе клиент не увидит новую
// версию либо не сможет докачать её по частям.
//
// Обновление накатывается само, без единого нажатия: это замена той же самой
// программы, а не установка новой, и спрашивать разрешение на каждую версию
// незачем. Скачиваем фоном, ставим при выходе из приложения.
//
// Единственное, чего избегаем, — закрыть приложение прямо посреди переписки.
// Поэтому момент установки выбирается по состоянию окна (см. update-downloaded).
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', state);
  }
}

autoUpdater.on('update-available', (info) => sendUpdateState({ status: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateState({ status: 'idle' }));
autoUpdater.on('download-progress', (p) => sendUpdateState({ status: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => {
  // releaseDate кладёт в latest.yml сам electron-builder при сборке — по нему
  // мы отличаем расписание, назначенное под этот билд, от оставшегося с
  // прошлого раза (см. dueAt).
  pendingUpdate = { version: info.version, releaseDate: Date.parse(info.releaseDate) };
  // Ловим отказ явно: это main-процесс, и необработанный промис здесь роняет
  // не вкладку, а всё приложение.
  applySchedule().catch((e) => console.error('Расписание обновления не применилось:', e.message));
});
autoUpdater.on('error', (e) => {
  // Недоступный сервер обновлений — не повод показывать ошибку человеку,
  // который просто работает в мессенджере. Пишем в лог и молчим.
  console.error('Ошибка автообновления:', e.message);
  sendUpdateState({ status: 'error', message: e.message });
});

// В dev-режиме обновляться неоткуда: app-update.yml появляется только в
// собранном приложении, и autoUpdater валится с ошибкой на старте.
const canUpdate = !isDev && process.platform === 'win32';
// Раньше здесь стояло 4 часа: проверка на фоне честно работала, но за это
// время человек, тестирующий свежую сборку, ни разу её не застанет и решит,
// что автообновление не работает вовсе — увидит новую версию только открыв
// Настройки, где есть отдельный запрос по требованию. Сам запрос к серверу
// — это несколько сотен байт latest.yml, поэтому от частой проверки ничего
// не жалко.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function checkForUpdates() {
  if (!canUpdate) return;
  // Обновление уже скачано и ждёт назначенного часа: новых версий искать не
  // нужно, а вот расписание админ мог передвинуть — перечитываем его.
  if (pendingUpdate) {
    applySchedule().catch((e) => console.error('Расписание обновления не применилось:', e.message));
    return;
  }
  autoUpdater.checkForUpdates().catch((e) => console.error('Проверка обновлений не удалась:', e.message));
}

function installUpdate() {
  if (!canUpdate) return;
  // Без этого сработает перехват закрытия окна, который прячет приложение
  // в трей, и установщик будет ждать выхода вечно.
  isQuitting = true;
  // Тихо и с автозапуском после установки: экран установщика человеку тут
  // показывать не за чем, а приложение должно вернуться само.
  autoUpdater.quitAndInstall(true, true);
}

// ===== Расписание установки =====
//
// Супер-админ может назначить момент, раньше которого обновление ставить
// нельзя. Скачивание при этом не откладывается — ждёт только установка: иначе
// в назначенный час все клиенты разом пойдут на сервер за 80 МБ.
//
// Адрес берём из того же build.publish, откуда качаются обновления. Своей
// конфигурации у main-процесса нет: базовый URL API прошит в рендерер при
// сборке, а сессии, чтобы спросить его там, у main тоже нет.
const SCHEDULE_URL = (() => {
  try {
    const publishUrl = require('../package.json').build.publish[0].url;
    return new URL('../api/updates/schedule', publishUrl).toString();
  } catch {
    return null;
  }
})();

const SCHEDULE_FETCH_TIMEOUT_MS = 10000;

// Обновление, которое уже скачано и ждёт своего часа.
let pendingUpdate = null;
let installTimer = null;

// Момент запуска приложения. Нужен, чтобы отличить «обновление ждало нас
// выключенными» от «вышло, пока человек работает»: в первом случае ставим
// сразу, во втором — по состоянию окна.
const launchedAt = Date.now();
const STARTUP_INSTALL_WINDOW_MS = 5 * 60 * 1000;

async function fetchNotBefore() {
  if (!SCHEDULE_URL) return null;
  try {
    const response = await fetch(SCHEDULE_URL, {
      signal: AbortSignal.timeout(SCHEDULE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Number.isFinite(data.notBefore) ? data.notBefore : null;
  } catch (e) {
    // Сервер расписания недоступен — не повод держать обновление вечно.
    // Считаем, что расписания нет, и ставим по обычным правилам.
    console.error('Расписание обновлений недоступно:', e.message);
    return null;
  }
}

// Момент, раньше которого ставить нельзя. Время, назначенное раньше, чем
// собран билд, осталось от прошлого выпуска и ничего не откладывает — иначе
// однажды выставленная дата навсегда отпускала бы все будущие версии сразу.
function dueAt(notBefore) {
  if (!notBefore || notBefore <= pendingUpdate.releaseDate) return 0;
  return notBefore;
}

async function applySchedule() {
  if (!pendingUpdate) return;

  clearTimeout(installTimer);
  installTimer = null;

  const due = dueAt(await fetchNotBefore());
  const wait = due - Date.now();

  if (wait > 0) {
    sendUpdateState({ status: 'scheduled', version: pendingUpdate.version, at: due });
    // Таймер ставим только на близкие сроки: далёкую дату подхватит очередная
    // проверка обновлений, а заодно и увидит, если админ её передвинул.
    if (wait <= UPDATE_CHECK_INTERVAL_MS) installTimer = setTimeout(applySchedule, wait);
    return;
  }

  sendUpdateState({ status: 'downloaded', version: pendingUpdate.version });

  // Обновление ждало нас выключенными — ставим сразу, не дожидаясь, пока
  // приложение свернут: на старте человек ещё ничего не начал, а перезапуск
  // ему ничего не стоит. Окно проверки узкое, чтобы медленная закачка не
  // выдернула приложение у того, кто уже сел работать.
  const startedRecently = Date.now() - launchedAt < STARTUP_INSTALL_WINDOW_MS;

  // Иначе ждём момента, когда за приложением никто не сидит. Трей здесь
  // принципиален: закрытие окна прячет приложение, а не завершает его, так
  // что выхода можно ждать неделями — без этой ветки обновление висело бы
  // скачанным и неустановленным до перезагрузки машины.
  const unattended = !mainWindow || mainWindow.isDestroyed()
    || (!mainWindow.isVisible() && !mainWindow.isFocused());

  if (startedRecently || unattended) installUpdate();
  // Не подошло ни то, ни другое — обновление встанет при закрытии приложения
  // (autoInstallOnAppQuit) либо по кнопке «Перезапустить» в настройках.
}

ipcMain.on('update:check', () => checkForUpdates());
// Обновление ставится само; это на случай, если человек не хочет ждать
// закрытия приложения и жмёт «Перезапустить» в настройках.
ipcMain.on('update:install', () => installUpdate());

ipcMain.handle('app:version', () => app.getVersion());

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
