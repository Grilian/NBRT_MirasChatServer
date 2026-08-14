const { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, nativeImage, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { releaseVersion } = require('../package.json');

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

const DEFAULT_STATE = { width: 1200, height: 800, x: undefined, y: undefined, isMaximized: false, mode: 'normal' };
// Как приложение было закрыто в прошлый раз: развёрнутым, свёрнутым в панель
// задач или спрятанным в трей. Перезагрузка машины и установка обновления
// завершают приложение помимо нашей воли, поэтому режим пишется на каждое
// изменение, а не только при выходе.
const WINDOW_MODES = ['normal', 'minimized', 'tray'];
// Нижняя граница окна — мобильная ширина, а не десктопная.
//
// Было 860, и это ровно та причина, по которой узкие режимы приложения
// оказывались недостижимы: компактный список чатов начинается с 852px, а
// мобильный вид — с 760px, то есть окно упиралось в минимум РАНЬШЕ, чем
// приложение успевало до них дойти. Человек тянул рамку, окно останавливалось,
// и выглядело это как «дальше не сужается».
//
// 380px — ширина телефона: в этом окне работает настоящий мобильный интерфейс
// (нижняя навигация, экраны по очереди), и им же удобно проверять мобильную
// вёрстку не собирая APK.
const MIN_WIDTH = 380;
const MIN_HEIGHT = 520;

let mainWindow = null;
let tray = null;
let isQuitting = false;

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    if (!WINDOW_MODES.includes(state.mode)) state.mode = DEFAULT_STATE.mode;
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeWindowState(patch) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...loadWindowState(), ...patch }));
  } catch {
    // не критично, окно просто откроется со значениями по умолчанию в след. раз
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  // У свёрнутого и спрятанного окна getBounds отдаёт бесполезные координаты
  // (Windows уводит свёрнутое окно за экран), поэтому геометрию в этих
  // состояниях не трогаем — остаётся та, что была до сворачивания.
  if (isMaximized || win.isMinimized() || !win.isVisible()) {
    writeWindowState({ isMaximized });
    return;
  }
  const bounds = win.getBounds();
  writeWindowState({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized
  });
}

function saveWindowMode(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) writeWindowState({ mode: 'tray' });
  else if (win.isMinimized()) writeWindowState({ mode: 'minimized' });
  else writeWindowState({ mode: 'normal' });
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
    // Возвращаемся туда, где человек оставил приложение. В трей — вообще не
    // показываясь: показать и тут же спрятать значит моргнуть окном на весь
    // экран при каждом старте с автозагрузки.
    if (state.mode === 'tray') return;
    if (state.mode === 'minimized') {
      mainWindow.showInactive();
      mainWindow.minimize();
      return;
    }
    mainWindow.show();
  });

  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));

  mainWindow.on('minimize', () => saveWindowMode(mainWindow));
  mainWindow.on('restore', () => saveWindowMode(mainWindow));

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
  mainWindow.on('hide', () => {
    mainWindow.webContents.send('window:focus-changed', false);
    saveWindowMode(mainWindow);
  });
  mainWindow.on('show', () => {
    if (mainWindow.isFocused()) mainWindow.webContents.send('window:focus-changed', true);
    saveWindowMode(mainWindow);
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
function setUnreadBadge(count, badgeDataUrl) {
  const hasUnread = count > 0;

  if (tray) {
    tray.setImage(path.join(ASSETS_DIR, hasUnread ? 'tray-unread.png' : 'tray.png'));
    tray.setToolTip(hasUnread ? `MirasChat — непрочитанных: ${count}` : 'MirasChat');
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    // Картинку с числом рисует рендерер и присылает готовой (см.
    // utils/badgeIcon.ts): в main-процессе нет canvas, а тянуть графическую
    // библиотеку в сборку ради кружка с цифрой незачем. Заранее нарисованная
    // точка остаётся запасным вариантом — на случай, если рендерер прислал
    // счётчик без картинки (старая сборка веб-части внутри новой оболочки).
    let overlay = null;
    if (hasUnread) {
      overlay = badgeDataUrl
        ? nativeImage.createFromDataURL(badgeDataUrl)
        : nativeImage.createFromPath(path.join(ASSETS_DIR, 'overlay-unread.png'));
    }

    mainWindow.setOverlayIcon(
      overlay,
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
// Четвёртую пользовательскую цифру версии Electron хранит как prerelease:
// 1.6.9.1 -> 1.6.10-hotfix.1. Такой номер новее 1.6.9, но старее будущей
// функциональной 1.6.10. Без этого флага стабильный клиент пропускает хотфиксы.
autoUpdater.allowPrerelease = true;

// Разрешаем УМЕНЬШЕНИЕ версии. Без этого флага electron-updater ставит только
// то, что новее установленного, и откат из панели управления (кнопка «Версии и
// откат») до клиентов бы не доехал вовсе: манифест уже указывает на старую
// сборку, а клиент считает, что он новее, и обновляться отказывается.
//
// Само по себе это не опасно: что раздавать, решает latest.yml на нашем
// сервере, а не клиент. Откатили сборку — клиенты вернулись; вернули новую —
// снова обновились.
autoUpdater.allowDowngrade = true;

// Установку при выходе включаем только когда обновление реально можно ставить.
// Раньше здесь стояло true намертво, и это перебивало расписание: назначили
// установку на пятницу, человек вышел из приложения в среду — electron-updater
// ставил обновление сам, мимо всей нашей логики. Флаг теперь двигает
// applySchedule: false, пока ждём назначенного часа, true — когда он наступил.
autoUpdater.autoInstallOnAppQuit = false;

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

  // Расписание админ мог передвинуть, пока скачанное обновление ждёт своего
  // часа — перечитываем его на каждой проверке.
  if (pendingUpdate) {
    applySchedule().catch((e) => console.error('Расписание обновления не применилось:', e.message));
  }

  // И всё равно спрашиваем сервер. Раньше при скачанном обновлении проверка
  // пропускалась совсем, и если за время ожидания выходила версия новее,
  // клиент так и ставил залежавшуюся: с сервера она к тому моменту уже
  // удалена, а установить старое поверх нового Windows потом не даст.
  // Найдётся версия новее — electron-updater скачает её и снова пришлёт
  // update-downloaded, а тот перезапишет pendingUpdate и расписание.
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
    // Назначенный час ещё не наступил — снимаем установку при выходе, иначе
    // electron-updater поставит обновление сам, стоит человеку закрыть
    // приложение, и расписание не будет значить ничего.
    autoUpdater.autoInstallOnAppQuit = false;
    sendUpdateState({ status: 'scheduled', version: pendingUpdate.version, at: due });
    // Таймер ставим только на близкие сроки: далёкую дату подхватит очередная
    // проверка обновлений, а заодно и увидит, если админ её передвинул.
    if (wait <= UPDATE_CHECK_INTERVAL_MS) {
      installTimer = setTimeout(() => {
        applySchedule().catch((e) => console.error('Расписание обновления не применилось:', e.message));
      }, wait);
    }
    return;
  }

  // Ставить уже можно — возвращаем установку при выходе как запасной путь на
  // случай, если ни одно из условий ниже сейчас не выполнится.
  autoUpdater.autoInstallOnAppQuit = true;
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

// В настройках и отчёте серверу показываем общий номер всех платформ, а не
// технический SemVer, необходимый electron-updater.
ipcMain.handle('app:version', () => releaseVersion || app.getVersion());

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
ipcMain.on('unread:set', (event, count, badgeDataUrl) => setUnreadBadge(Number(count) || 0, badgeDataUrl));
ipcMain.on('window:flash', () => flashOnNewMessage());

// Клик по всплывающему уведомлению — окно может быть свёрнуто в трей
// (mainWindow.hide()), обычного window.focus() из рендерера для этого мало.
ipcMain.on('window:focus', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

/**
 * Раздвинуть окно вправо под правую область приложения.
 *
 * Требование интерфейса: открытие ветки (или сведений о чате) в узком окне не
 * должно ни наезжать на переписку, ни молча не срабатывать — приложение
 * выходит из узкого состояния и освобождает место. Растём именно вправо,
 * оставляя левый край на месте: окно не должно «прыгать» под курсором.
 *
 * Развёрнутое окно не трогаем — оно и так во весь экран, и если панель туда не
 * влезла, раздвигать нечего.
 */
ipcMain.handle('window:ensure-width', (event, requested) => {
  const target = Math.round(Number(requested) || 0);
  if (!mainWindow || !Number.isFinite(target) || target <= 0) return false;
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return false;

  const bounds = mainWindow.getBounds();
  if (bounds.width >= target) return false;

  // Шире рабочей области экрана не растём и за её правый край не вылезаем:
  // окно, уехавшее под панель задач или на несуществующий монитор, человек
  // потом не найдёт.
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(target, area.width);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);

  mainWindow.setBounds({ x, y: bounds.y, width, height: bounds.height }, true);
  return true;
});

// Системные уведомления рисует главный процесс, а не рендерер.
//
// Рендерер грузится через loadFile(), то есть с origin file://, а Chromium
// считает его небезопасным контекстом и Notification API там запрещён:
// Notification.permission равен 'denied' навсегда, запросить разрешение
// нельзя, и new Notification() в рендерере молча ничего не показывал —
// именно поэтому на десктопе уведомления не появлялись вовсе. У главного
// процесса таких ограничений нет.
const liveNotifications = new Map();

ipcMain.on('notify:show', (event, options) => {
  if (!Notification.isSupported()) return;
  try {
    const { title, body, tag } = options && typeof options === 'object' ? options : {};
    // Предыдущее уведомление того же чата закрываем сами: иначе на одно
    // сообщение в шторке копится по карточке на каждое сообщение.
    liveNotifications.get(tag)?.close();

    const notification = new Notification({
      title: String(title || 'MirasChat'),
      body: String(body || ''),
      icon: path.join(ASSETS_DIR, 'icon.png'),
      silent: true, // звук играет сам клиент, чтобы он был одинаковым везде
    });

    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('notification:clicked', tag);
      }
      liveNotifications.delete(tag);
    });
    notification.on('close', () => {
      if (liveNotifications.get(tag) === notification) liveNotifications.delete(tag);
    });

    liveNotifications.set(tag, notification);
    notification.show();
  } catch (e) {
    // Уведомления — необязательный канал: внутриприложенческий тост
    // показывается в любом случае, ронять из-за них ничего нельзя.
    console.error('Ошибка показа уведомления:', e.message);
  }
});

ipcMain.on('notify:close', (event, tag) => {
  liveNotifications.get(tag)?.close();
  liveNotifications.delete(tag);
});

ipcMain.on('notify:close-all', () => {
  liveNotifications.forEach((notification) => notification.close());
  liveNotifications.clear();
});
