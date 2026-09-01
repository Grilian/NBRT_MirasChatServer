const { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, nativeImage, Notification, session, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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

// ===== Автозагрузка =====
//
// app.setLoginItemSettings()/getLoginItemSettings() в Electron документированы
// как «Windows и macOS only» — на Linux это тихая заглушка, ничего не делает
// и не бросает ошибку, поэтому баг было не так просто заметить: переключатель
// в настройках щёлкается, but Astra и Zorin его просто игнорируют. Свой путь
// для Linux — обычный .desktop-файл в ~/.config/autostart/, это открытый
// XDG-стандарт автозапуска, который понимают что GNOME (Zorin), что более
// старые окружения вроде Fly в Astra (там же исторически MATE), без
// зависимости от конкретного DE.
const LINUX_AUTOSTART_DIR = path.join(os.homedir(), '.config', 'autostart');
const LINUX_AUTOSTART_PATH = path.join(LINUX_AUTOSTART_DIR, 'ru.miras.mirasChat.desktop');

function buildLinuxAutostartEntry() {
  // process.execPath — реальный путь до уже запущенного бинарника: тот же
  // самый файл, на который смотрит ярлык из меню приложений, независимо от
  // того, как именно electron-builder назвал исполняемый файл внутри .deb, и
  // не ломается, если человек распаковал портативную tar.gz-версию в
  // произвольную папку.
  const execPath = process.execPath;
  const exec = execPath.includes(' ') ? `"${execPath}"` : execPath;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=MirasChat',
    'Comment=Автозапуск корпоративного мессенджера MirasChat',
    `Exec=${exec}`,
    'Terminal=false',
    'NoDisplay=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false',
    '',
  ].join('\n');
}

function getAutoLaunchEnabled() {
  if (process.platform === 'linux') {
    try {
      return fs.existsSync(LINUX_AUTOSTART_PATH);
    } catch {
      return false;
    }
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoLaunchEnabled(enabled) {
  if (process.platform === 'linux') {
    try {
      if (enabled) {
        fs.mkdirSync(LINUX_AUTOSTART_DIR, { recursive: true });
        fs.writeFileSync(LINUX_AUTOSTART_PATH, buildLinuxAutostartEntry());
      } else if (fs.existsSync(LINUX_AUTOSTART_PATH)) {
        fs.unlinkSync(LINUX_AUTOSTART_PATH);
      }
    } catch (e) {
      console.error('Не удалось изменить автозагрузку (Linux):', e.message);
    }
    return getAutoLaunchEnabled();
  }
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return app.getLoginItemSettings().openAtLogin;
}


//
// Сервер живёт во внутренней сети конторы, и на некоторых сетях (домашний
// интернет, гостевой Wi-Fi, VPN без прописанного прокси в системе) до него
// просто не достучаться напрямую — чат перестаёт работать без единой
// подсказки почему. Electron по умолчанию берёт прокси из системных настроек
// ОС (mode: 'system'), но у многих машин прокси прописан только в браузере, а
// не на уровне Windows/Linux — тогда системный режим ничего не находит.
//
// Решение — своя настройка на уровне приложения, в обход системной: либо
// прокси-сервер руками (адрес:порт), либо готовый PAC ЦИТ-а, который сам
// решает по каждому адресу, идти ли через прокси.
//
// PAC зашит в приложение целиком (см. CIT_PAC_SCRIPT), а не скачивается на
// лету с http://i.tatar.ru/wpad.dat: WPAD-сервер отдаёт этот файл только
// изнутри самой сети ЦИТ, а если внешняя сеть уже сломана — то есть ровно
// тогда, когда прокси и нужен, — Chromium не может даже загрузить сам PAC,
// чтобы понять, что делать. Содержимое взято из выгруженного администратором
// wpad.dat и должно обновляться вручную здесь же, если ЦИТ поменяет правила.
const CIT_PAC_SCRIPT = `function FindProxyForURL(url, host)

{


// variable strings to return
var proxy_yes = "PROXY i.tatar.ru:8080;";
var proxy_no = "DIRECT";


if (isInNet( host, "85.233.64.0","255.255.240.0" )
|| isInNet( host, "91.132.96.0","255.255.252.0" )
|| isInNet( host, "10.0.0.0","255.0.0.0" )
|| isInNet( host, "127.0.0.0","255.0.0.0" )
|| isInNet( host, "188.128.26.229","255.255.255.255")
|| isInNet( host, "95.163.50.11","255.255.255.255")
|| isInNet( host, "88.210.30.4","255.255.255.255")
|| isInNet( host, "192.168.0.0","255.255.0.0")
|| isInNet( host, "172.16.0.0","255.240.0.0" )
|| isInNet( host, "95.173.158.72","255.255.255.255" )
|| isInNet( host, "91.215.39.160","255.255.255.255" )) {

return proxy_no;

}


if ( shExpMatch( host, "localhost" )
|| isPlainHostName( host )
|| dnsDomainIs( host, "eln.fss.ru")
|| dnsDomainIs( host, "taxi.mintrans.gov.ru")
|| dnsDomainIs( host, "energy.tcrypt.ru")
|| dnsDomainIs( host, "cryptoagent.ru")
|| dnsDomainIs( host, "fin.favr.ru")
|| dnsDomainIs( host, "ru.public.express")) {

return proxy_no;

}


urllower = url.toLowerCase();
 if((urllower.substring(0,5)=="rtsp:") ||
   (urllower.substring(0,6)=="rtspt:") ||
   (urllower.substring(0,6)=="rtspu:") ||
   (urllower.substring(0,4)=="mms:") ||
   (urllower.substring(0,5)=="mmst:") ||
   (urllower.substring(0,5)=="mmsu:"))
  return proxy_no;










return proxy_yes;

}
`;
// Показываем человеку и проверяем доступность именно его — сам PAC-скрипт
// вычитывать для этого незачем, адрес и так известен заранее.
const CIT_PROXY_HOST = 'i.tatar.ru';
const CIT_PROXY_PORT = 8080;
// Внутренняя сеть ЦИТ — если машина получила такой адрес по DHCP, скорее
// всего, прокси там тоже доступен без ручной настройки.
const CIT_IP_PREFIX = '10.1.';
const CIT_CHECK_TIMEOUT_MS = 3000;
// Не мгновенно после старта (сеть могла ещё не подняться), и не слишком
// редко — ноутбук успевает сменить сеть за время одной рабочей сессии.
const PROXY_AUTO_CHECK_INTERVAL_MS = 60 * 1000;

// Пароль от прокси ЦИТ хранится в app-state.json, но не как есть: Electron
// умеет шифровать строки через хранилище секретов самой ОС (Credential
// Manager на Windows, libsecret на Linux — тот же libsecret1, что уже входит
// в зависимости .deb). Если хранилища на машине нет (бывает на Linux без
// поднятого gnome-keyring/kwallet — не редкость на Astra), сохраняем как
// есть: без этого функция просто не работала бы вовсе, а обычные файловые
// права на userData-папку — не худшая защита в остальных случаях.
function encryptSecret(plain) {
  if (!plain) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, value: safeStorage.encryptString(plain).toString('base64') };
  }
  return { enc: false, value: plain };
}

function decryptSecret(stored) {
  if (!stored || typeof stored.value !== 'string') return '';
  if (!stored.enc) return stored.value;
  if (!safeStorage.isEncryptionAvailable()) return ''; // хранилище пропало (сменили машину/профиль) — лучше пусто, чем мусор
  try {
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
  } catch {
    return '';
  }
}

function getProxyState() {
  const saved = (loadAppState().proxy) || {};
  return {
    enabled: !!saved.enabled,
    mode: ['manual', 'system', 'cit'].includes(saved.mode) ? saved.mode : 'cit',
    manualHost: typeof saved.manualHost === 'string' ? saved.manualHost : '',
    manualPort: typeof saved.manualPort === 'string' ? saved.manualPort : '',
    citUsername: typeof saved.citUsername === 'string' ? saved.citUsername : '',
    // Сам пароль наружу, в рендерер, никогда не отдаём — только факт, что он
    // сохранён, чтобы поле в интерфейсе могло показать плейсхолдер вместо
    // пустого места, не раскрывая значение.
    citPasswordSet: !!saved.citPassword,
    // Диагностика реального результата авторизации — см. attachProxyAuthHandler.
    citAuthStatus: citAuthState.lastResult,
  };
}

function buildProxyConfig(state) {
  if (!state.enabled) return { mode: 'system' };
  if (state.mode === 'manual') {
    const host = state.manualHost.trim();
    if (!host) return { mode: 'system' }; // включили, но ничего не вписали — вести себя как выключенный
    const port = state.manualPort.trim();
    // <local> — обращения к localhost/127.0.0.1 (например, к самому себе на
    // время разработки) прокси не трогает.
    return { mode: 'fixed_servers', proxyRules: port ? `${host}:${port}` : host, proxyBypassRules: '<local>' };
  }
  if (state.mode === 'system') {
    // Доверяем прокси, уже настроенному в самой ОС — на Zorin (GNOME) это
    // «Настройки → Сеть → Прокси сети», на некоторых машинах то же самое
    // читается из переменных окружения http_proxy/https_proxy. Ровно то,
    // чем в такой ситуации и так уже пользуется браузер, поэтому это самый
    // надёжный вариант там, где человек это один раз настроил вручную в ОС.
    return { mode: 'system' };
  }
  // ЦИТ — data: URL с PAC-скриптом внутри: Chromium поддерживает эту схему
  // для pac_script точно так же, как http(s)/file, но без похода в сеть.
  const pacDataUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(CIT_PAC_SCRIPT, 'utf8').toString('base64')}`;
  return { mode: 'pac_script', pacScript: pacDataUrl };
}

// Что реально произошло с последней попыткой логина на прокси — единственный
// практичный способ отличить «неверный логин/пароль» от «прокси в принципе
// не отвечает» и от «прокси вообще не спрашивает авторизацию», когда сам
// Chromium никакого текста ошибки не показывает и разбираться приходится
// вслепую. lastResult: null (ещё не пробовали) | 'no-credentials' (логин не
// заполнен) | 'pending' (только что подставили, ждём исхода) | 'rejected'
// (тот же прокси спросил снова — значит, не принял то, что мы дали).
let citAuthState = { attempts: 0, lastResult: null, lastChallengeKey: null };

function resetCitAuthState() {
  citAuthState = { attempts: 0, lastResult: null, lastChallengeKey: null };
}

// Логин и пароль от корпоративного прокси приложение не вводит само в
// диалоге — оно заранее подставляет их в ответ на HTTP 407, как только
// Chromium его пришлёт. Событие 'login' общее и для проксей, и для сайтов с
// Basic-авторизацией — обязательно проверяем isProxy, иначе можно случайно
// подставить пароль от прокси на любой сайт, спросивший логин.
//
// Раньше подстановка была жёстко привязана к mode === 'cit'. Это неверно:
// логин и пароль относятся к самому прокси-серверу, а не к тому, каким
// способом приложение его нашло — тот же govtatar\auto.nbrt нужен и когда
// прокси найден через встроенный PAC ЦИТ, и когда используется системная
// настройка ОС (mode 'system'), и в теории даже при ручном адресе, если он
// указывает на тот же сервер. Подставляем сохранённые данные при любом
// прокси-запросе логина, если они вообще заполнены — не только в режиме ЦИТ.
function attachProxyAuthHandler(targetSession) {
  targetSession.removeAllListeners('login'); // applyProxyState() дергается многократно за сессию — слушатели не должны копиться
  targetSession.on('login', (event, authInfo, callback) => {
    if (!authInfo.isProxy) { callback(); return; }

    const saved = (loadAppState().proxy) || {};
    const username = typeof saved.citUsername === 'string' ? saved.citUsername.trim() : '';
    if (!username) {
      citAuthState = { attempts: 0, lastResult: 'no-credentials', lastChallengeKey: null };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proxy:state-changed', getProxyState());
      }
      callback(); // нет сохранённых данных — пусть Chromium обработает как умеет
      return;
    }

    // Тот же прокси (host:port и схема авторизации) спросил логин снова
    // почти сразу после того, как мы его уже подставляли, — единственный
    // доступный нам признак, что Chromium не принял то, что мы дали.
    // Правильные данные повторного запроса на той же сессии не вызывают.
    const challengeKey = `${authInfo.host}:${authInfo.port}:${authInfo.scheme}`;
    citAuthState = {
      attempts: citAuthState.attempts + 1,
      lastResult: citAuthState.lastChallengeKey === challengeKey ? 'rejected' : 'pending',
      lastChallengeKey: challengeKey,
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('proxy:state-changed', getProxyState());
    }

    const password = decryptSecret(saved.citPassword);
    event.preventDefault();
    // NTLM/Negotiate-прокси (govtatar\auto.nbrt — характерный формат именно
    // NTLM) сами разбирают "домен\имя" в один параметр username — Chromium
    // делает это тем же кодом что и для встроенного диалога браузера, так
    // что здесь ничего специально разделять на домен и логин не нужно.
    callback(username, password);
  });
}

async function applyProxyState() {
  const config = buildProxyConfig(getProxyState());
  const targetSession = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.webContents.session
    : session.defaultSession;
  try {
    await targetSession.setProxy(config);
    attachProxyAuthHandler(targetSession);
  } catch (e) {
    console.error('Не удалось применить настройки прокси:', e.message);
  }
}

// Прямая проверка TCP-соединения с самим прокси, в обход electron-сессии:
// нужно понять, виден ли ЦИТ вообще с этой сети, а не проверить уже
// применённый прокси (для этого он ещё не применён, когда решаем, показывать
// ли адрес бледным). PAC теперь зашит в приложении и сети для его получения
// не требует — проверяем доступность самого прокси-порта, а не файла.
function checkCitReachable() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const socket = net.createConnection({ host: CIT_PROXY_HOST, port: CIT_PROXY_PORT, timeout: CIT_CHECK_TIMEOUT_MS });
      socket.once('connect', () => { socket.destroy(); finish(true); });
      socket.once('timeout', () => { socket.destroy(); finish(false); });
      socket.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function hasCitNetworkIp() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces).flat().some(
    (iface) => iface && iface.family === 'IPv4' && !iface.internal && iface.address.startsWith(CIT_IP_PREFIX)
  );
}

// Автовключение — необязательная подсказка, а не решение вместо человека:
// как только он хоть раз тронул настройку прокси руками (setProxyState с
// userTouched), автоопределение больше не вмешивается, даже если позже он
// снова окажется в сети ЦИТ и сам выключит прокси.
//
// Только Linux: на Windows прокси нужен эпизодически и обычно уже прописан
// в системе (браузер/групповые политики), а на Astra/Linux своей настройки
// прокси в системе исторически нет вовсе — отсюда и просьба автоматизировать
// именно эту платформу. На Windows автоопределение не трогаем: там прокси
// по умолчанию должен оставаться выключенным независимо от IP.
//
// Логин/пароль автоматика не подставляет — их ЦИТ выдаёт человеку лично,
// сама программа их знать не может. Прокси включится, но запросы так и
// останутся заблокированы 407, пока эти данные не впишут в настройках руками.
async function maybeAutoEnableCitProxy() {
  if (process.platform !== 'linux') return;
  const saved = loadAppState().proxy || {};
  if (saved.userTouched) return;
  if (saved.enabled && saved.mode === 'cit') return; // уже применено — незачем трогать снова
  if (!hasCitNetworkIp()) return;

  saveAppState({ proxy: { ...saved, enabled: true, mode: 'cit' } });
  await applyProxyState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    const citReachable = await checkCitReachable();
    mainWindow.webContents.send('proxy:state-changed', { ...getProxyState(), citReachable });
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
  const state = loadAppState();

  // Отдельный одноразовый флаг для Linux: до этого фикса переключатель ничего
  // не делал (Electron документирует setLoginItemSettings как «Windows и
  // macOS only», на Linux — тихая заглушка), поэтому у всех уже
  // установленных на Astra/Zorin версий автозагрузка не была настроена
  // по-настоящему, даже если общий autoLaunchInitialized уже стоит и человек
  // раньше щёлкал переключатель — сохранять в таком состоянии нечего.
  if (process.platform === 'linux' && !state.linuxAutoLaunchMigrated) {
    try {
      setAutoLaunchEnabled(true);
    } catch (e) {
      console.error('Не удалось включить автозагрузку (Linux):', e.message);
    }
    saveAppState({ linuxAutoLaunchMigrated: true, autoLaunchInitialized: true });
    return;
  }

  if (state.autoLaunchInitialized) return;
  try {
    setAutoLaunchEnabled(true);
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

  // До того, как рендерер успеет сделать хоть один запрос: применённые здесь
  // настройки прокси действуют на всю сессию окна, независимо от момента
  // навигации.
  applyProxyState();

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

    // Сеть на старте могла ещё не подняться — небольшая задержка перед первой
    // проверкой, дальше просто по интервалу.
    setTimeout(maybeAutoEnableCitProxy, 5000);
    setInterval(maybeAutoEnableCitProxy, PROXY_AUTO_CHECK_INTERVAL_MS);

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
//
// electron-updater умеет самообновляться из коробки только на Windows (NSIS)
// и из AppImage на Linux — а раздаём мы .deb/.tar.gz, так что для Linux этот
// путь не подходит принципиально. Обновление там сделано отдельным, простым
// путём чуть ниже (см. «Обновление на Linux»): чтобы попасть на новую
// версию, не нужно было заново искать сайт и скачивать пакет вручную — тот
// же экран в настройках, тот же прогресс закачки, разница только в
// последнем шаге (открыть .deb вместо тихой переустановки).
const canUpdate = !isDev && process.platform === 'win32';
// Раньше здесь стояло 4 часа: проверка на фоне честно работала, но за это
// время человек, тестирующий свежую сборку, ни разу её не застанет и решит,
// что автообновление не работает вовсе — увидит новую версию только открыв
// Настройки, где есть отдельный запрос по требованию. Сам запрос к серверу
// — это несколько сотен байт latest.yml, поэтому от частой проверки ничего
// не жалко.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function checkForUpdates() {
  if (canUpdate) {
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
    return;
  }

  if (process.platform === 'linux' && !isDev) {
    checkLinuxUpdate().catch((e) => console.error('Проверка обновлений для Linux не удалась:', e.message));
  }
}

function installUpdate() {
  if (process.platform === 'linux') {
    installLinuxUpdate();
    return;
  }
  if (!canUpdate) return;
  // Без этого сработает перехват закрытия окна, который прячет приложение
  // в трей, и установщик будет ждать выхода вечно.
  isQuitting = true;
  // Тихо и с автозапуском после установки: экран установщика человеку тут
  // показывать не за чем, а приложение должно вернуться само.
  autoUpdater.quitAndInstall(true, true);
}

// ===== Обновление на Linux =====
//
// .deb и .tar.gz electron-updater самостоятельно поставить не умеет (только
// AppImage на Linux, только NSIS на Windows), а сама раздача уже настроена
// через свой манифест linux.json (см. server/services/releases.js — тот же
// файл, что писала кнопка «Откат» в панели администратора). Поэтому вместо
// того чтобы городить AppImage или демона с правами root ради тихой
// переустановки .deb, программа сама скачивает новый пакет и открывает его
// системным обработчиком — тем же диалогом, который увидел бы человек,
// дважды кликнув на скачанный .deb в файловом менеджере. Правами root это
// всё равно управляет ОС, а не наше приложение, но искать сайт и качать
// заново человеку больше не нужно.
let linuxUpdateReady = null; // { version, path } — то, что уже скачано и ждёт открытия

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

const LINUX_MANIFEST_URL = (() => {
  try {
    const publishUrl = require('../package.json').build.publish[0].url;
    return new URL('linux.json', publishUrl).toString();
  } catch {
    return null;
  }
})();

async function downloadLinuxUpdate(url, version) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать обновление: ${response.status}`);

  const total = Number(response.headers.get('content-length')) || 0;
  let fileName;
  try {
    fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    fileName = '';
  }
  if (!fileName) fileName = `MirasChat_${version}_amd64.deb`;
  const destPath = path.join(app.getPath('temp'), fileName);

  let received = 0;
  let lastSentPercent = -1;
  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.on('data', (chunk) => {
    received += chunk.length;
    if (total <= 0) return;
    const percent = Math.min(99, Math.round((received / total) * 100));
    if (percent === lastSentPercent) return;
    lastSentPercent = percent;
    sendUpdateState({ status: 'linux-downloading', percent });
  });

  await pipeline(nodeStream, fs.createWriteStream(destPath));
  return destPath;
}

async function checkLinuxUpdate() {
  if (!LINUX_MANIFEST_URL) return;
  try {
    const response = await fetch(LINUX_MANIFEST_URL, {
      signal: AbortSignal.timeout(SCHEDULE_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return;
    const manifest = await response.json();
    if (!manifest.version || !manifest.url) return;

    const current = releaseVersion || app.getVersion();
    if (compareVersions(manifest.version, current) <= 0) {
      // Уже актуальны — старое скачанное (если было, например, откатили
      // версию на сервере уже после закачки) больше показывать незачем.
      if (linuxUpdateReady) {
        linuxUpdateReady = null;
        sendUpdateState({ status: 'idle' });
      }
      return;
    }

    // Этот .deb уже лежит скачанным — заново качать нечего, просто
    // напоминаем состояние (полезно, если settings открыли заново).
    if (linuxUpdateReady?.version === manifest.version) {
      sendUpdateState({ status: 'linux-ready', version: manifest.version });
      return;
    }

    sendUpdateState({ status: 'linux-downloading', percent: 0 });
    const destPath = await downloadLinuxUpdate(manifest.url, manifest.version);
    linuxUpdateReady = { version: manifest.version, path: destPath };
    sendUpdateState({ status: 'linux-ready', version: manifest.version });
  } catch (e) {
    console.error('Обновление для Linux не удалось скачать:', e.message);
    sendUpdateState({ status: 'error', message: e.message });
  }
}

function installLinuxUpdate() {
  if (!linuxUpdateReady) return;
  const { path: filePath } = linuxUpdateReady;
  // openPath запускает системный обработчик .deb (обычно это GUI-установщик
  // пакетов вроде GDebi или «Центра приложений») — то же самое действие, что
  // и двойной клик по скачанному файлу. Пустая строка означает успех;
  // непустая — путь к файлу или обработчик оказались недоступны.
  shell.openPath(filePath).then((err) => {
    if (err) console.error('Не удалось открыть установщик Linux:', err);
  });
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

ipcMain.handle('autostart:get', () => getAutoLaunchEnabled());
ipcMain.handle('autostart:set', (event, enabled) => setAutoLaunchEnabled(!!enabled));

// Состояние для настроек всегда возвращается вместе со свежей проверкой
// доступности ЦИТ — панели незачем делать для этого отдельный вызов.
ipcMain.handle('proxy:get', async () => {
  const state = getProxyState();
  const citReachable = await checkCitReachable();
  return { ...state, citReachable };
});

ipcMain.handle('proxy:set', async (event, patch) => {
  const current = getProxyState();
  const savedProxy = (loadAppState().proxy) || {};
  const next = {
    enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
    mode: ['manual', 'system', 'cit'].includes(patch?.mode) ? patch.mode : current.mode,
    manualHost: typeof patch?.manualHost === 'string' ? patch.manualHost.trim() : current.manualHost,
    manualPort: typeof patch?.manualPort === 'string' ? patch.manualPort.trim() : current.manualPort,
    citUsername: typeof patch?.citUsername === 'string' ? patch.citUsername.trim() : current.citUsername,
    // citPassword в patch: undefined — не трогать сохранённый; '' — явно
    // очистить (нажали «Убрать»); непустая строка — заменить новым. Сам
    // пароль в состоянии, которое утекает наружу через getProxyState(), не
    // участвует — только зашифрованный вид остаётся в app-state.json.
    citPassword: patch?.citPassword === undefined ? savedProxy.citPassword : encryptSecret(patch.citPassword),
  };
  // Логин/пароль или сам способ поиска прокси поменялись — прошлый исход
  // авторизации («отклонил») относится уже к другой попытке, показывать его
  // дальше означало бы врать про то, что ещё не проверялось.
  resetCitAuthState();
  // Ручное вмешательство человека — отключает автоопределение по IP
  // насовсем, чтобы оно больше не спорило с его выбором.
  saveAppState({ proxy: { ...next, userTouched: true } });
  await applyProxyState();
  const citReachable = await checkCitReachable();
  return { ...getProxyState(), citReachable };
});

ipcMain.handle('proxy:check-cit', () => checkCitReachable());

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

// Скачивание файла из переписки — задача главного процесса.
//
// В рендерере ссылка с target="_blank" открывала бы СТОРОННИЙ браузер (у нас
// на такие ссылки стоит shell.openExternal), то есть человек уходил бы из
// приложения ради собственного файла. Здесь же файл кладётся прямо в
// «Загрузки» и открывается папка с ним — как в любом нормальном клиенте.
ipcMain.handle('file:download', async (event, url, filename) => {
  if (!mainWindow || typeof url !== 'string') return { ok: false, error: 'Окно закрыто' };
  // Только http(s): downloadURL принял бы и file://, то есть рендерер мог бы
  // попросить «скачать» любой файл с диска себе же в «Загрузки».
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Некорректный адрес' };

  // Имя приходит из БД (его задавал отправитель) — разделители пути и
  // запрещённые в Windows символы убираем, иначе сохранение упадёт или уедет
  // в чужой каталог.
  const safeName = String(filename || 'file').replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const dir = app.getPath('downloads');

  // Имя не перезаписывает существующий файл: скачали дважды — получите (2).
  let target = path.join(dir, safeName);
  if (fs.existsSync(target)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    let n = 2;
    while (fs.existsSync(path.join(dir, `${base} (${n})${ext}`))) n += 1;
    target = path.join(dir, `${base} (${n})${ext}`);
  }

  return new Promise((resolve) => {
    const session = mainWindow.webContents.session;
    const onWillDownload = (_event, item) => {
      // Слушатель одноразовый и снимается сразу: иначе следующая загрузка
      // уехала бы в имя от предыдущей.
      session.removeListener('will-download', onWillDownload);
      item.setSavePath(target);
      item.once('done', (__event, state) => {
        if (state === 'completed') {
          resolve({ ok: true, path: target });
        } else {
          resolve({ ok: false, error: 'Загрузка прервана' });
        }
      });
    };
    session.on('will-download', onWillDownload);
    session.downloadURL(url);

    // Страховка от молчания: без неё интерфейс ждал бы обещания вечно.
    setTimeout(() => {
      session.removeListener('will-download', onWillDownload);
      resolve({ ok: false, error: 'Сервер не ответил' });
    }, 120000).unref?.();
  });
});

// Показать скачанный файл в проводнике — по нажатию на сообщение об успехе.
ipcMain.handle('file:reveal', (event, filePath) => {
  if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return false;
  shell.showItemInFolder(filePath);
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
