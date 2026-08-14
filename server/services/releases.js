const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Управление выложенными сборками: список того, что лежит на сервере, и
// переключение «текущей» версии — то есть откат.
//
// Что тут на самом деле происходит. Манифесты (`latest.yml` для Windows,
// `android.json` для Android, `linux.json` для Astra) — единственное, по чему
// клиент понимает, какая версия считается актуальной. Откат = переписать их
// на более старую сборку, которая всё ещё лежит рядом. Сами файлы сборок мы
// не трогаем и не удаляем: удалить — значит лишить себя возможности вернуться.
//
// ВАЖНО про Android. Откат там работает только для НОВЫХ установок: Android
// запрещает ставить APK с меньшим versionCode поверх большего
// (INSTALL_FAILED_VERSION_DOWNGRADE), и обойти это из приложения нельзя —
// только переустановкой вручную. Поэтому в панели об этом сказано прямо, а не
// умолчано: админ должен понимать, что уже обновившиеся телефоны останутся на
// новой версии.

// Каталог раздачи. На проде это /var/www/miraschat/updates, в разработке его
// обычно нет вовсе — тогда список просто пуст, а не падает.
const UPDATES_DIR = process.env.MIRAS_UPDATES_DIR || '/var/www/miraschat/updates';

const WINDOWS_PATTERN = /^MirasChat Setup (\d+\.\d+\.\d+)\.exe$/;
const ANDROID_PATTERN = /^MirasChat-(\d+\.\d+\.\d+)-debug\.apk$/;
const DEB_PATTERN = /^MirasChat_(\d+\.\d+\.\d+)_amd64\.deb$/;
const TARGZ_PATTERN = /^MirasChat_(\d+\.\d+\.\d+)_linux-x64\.tar\.gz$/;

class ReleaseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const dirExists = () => {
  try {
    return fs.statSync(UPDATES_DIR).isDirectory();
  } catch {
    return false;
  }
};

/** Сравнение версий по числам, а не по строке: «1.10.0» новее «1.9.0». */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

const readJson = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(UPDATES_DIR, name), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Реестр versionCode для Android.
 *
 * Из имени APK его не вывести (там только versionName), а разбирать бинарный
 * AndroidManifest ради одного числа — несоразмерно. Поэтому versionCode
 * запоминается в отдельном файле: он пополняется на каждом чтении из
 * действующего android.json, так что достаточно один раз выложить версию
 * обычным путём, чтобы её можно было потом откатить.
 */
const REGISTRY_NAME = 'releases.json';

function readRegistry() {
  const data = readJson(REGISTRY_NAME);
  return data && typeof data === 'object' && data.androidVersionCodes
    ? data
    : { androidVersionCodes: {} };
}

function writeRegistry(registry) {
  fs.writeFileSync(
    path.join(UPDATES_DIR, REGISTRY_NAME),
    `${JSON.stringify(registry, null, 2)}\n`,
    'utf8'
  );
}

function rememberAndroidVersionCode(version, versionCode) {
  if (!version || !Number.isInteger(versionCode)) return;
  const registry = readRegistry();
  if (registry.androidVersionCodes[version] === versionCode) return;
  registry.androidVersionCodes[version] = versionCode;
  writeRegistry(registry);
}

const sha512Base64 = (file) => crypto.createHash('sha512')
  .update(fs.readFileSync(file))
  .digest('base64');

/**
 * Что лежит на сервере и что сейчас считается актуальным.
 *
 * Версия попадает в список, даже если у неё есть не все платформы: сборки
 * выкладываются не всегда одновременно, и скрывать наполовину выложенную
 * версию значило бы прятать от админа то, что уже раздаётся.
 */
function listReleases() {
  if (!dirExists()) {
    return { available: false, dir: UPDATES_DIR, current: {}, releases: [] };
  }

  const files = fs.readdirSync(UPDATES_DIR);
  const byVersion = new Map();
  const ensure = (version) => {
    if (!byVersion.has(version)) {
      byVersion.set(version, { version, windows: null, android: null, deb: null, targz: null });
    }
    return byVersion.get(version);
  };

  for (const name of files) {
    let m;
    if ((m = WINDOWS_PATTERN.exec(name))) ensure(m[1]).windows = name;
    else if ((m = ANDROID_PATTERN.exec(name))) ensure(m[1]).android = name;
    else if ((m = DEB_PATTERN.exec(name))) ensure(m[1]).deb = name;
    else if ((m = TARGZ_PATTERN.exec(name))) ensure(m[1]).targz = name;
  }

  const latest = (() => {
    try {
      const text = fs.readFileSync(path.join(UPDATES_DIR, 'latest.yml'), 'utf8');
      return text.match(/^version:\s*(.+)$/m)?.[1]?.trim() || null;
    } catch {
      return null;
    }
  })();
  const android = readJson('android.json');
  const linux = readJson('linux.json');

  // Пополняем реестр тем, что видим прямо сейчас: без этого откат на текущую
  // версию был бы невозможен после первого же переключения.
  if (android?.versionName && Number.isInteger(android.versionCode)) {
    rememberAndroidVersionCode(android.versionName, android.versionCode);
  }
  const registry = readRegistry();

  const releases = [...byVersion.values()]
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((r) => ({
      ...r,
      androidVersionCode: registry.androidVersionCodes[r.version] ?? null,
      sizeBytes: r.windows
        ? fs.statSync(path.join(UPDATES_DIR, r.windows)).size
        : null,
    }));

  return {
    available: true,
    dir: UPDATES_DIR,
    current: {
      windows: latest,
      android: android?.versionName || null,
      androidVersionCode: android?.versionCode ?? null,
      linux: linux?.version || null,
    },
    releases,
  };
}

/**
 * Сделать указанную версию текущей — переписать манифесты.
 *
 * sha512 и размер считаются с файла на диске, а не берутся из старого
 * манифеста: манифест мог быть переписан кем угодно, а файл — вот он.
 */
function activateRelease(version) {
  if (!dirExists()) throw new ReleaseError('Каталог обновлений недоступен на этом сервере', 503);
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    throw new ReleaseError('Некорректный номер версии');
  }

  const state = listReleases();
  const target = state.releases.find((r) => r.version === version);
  if (!target) throw new ReleaseError('Такой сборки нет на сервере', 404);

  // СНАЧАЛА собираем всё, что собираемся записать, и только потом пишем.
  //
  // Раньше запись шла по ходу проверок, и на первой же неудаче (у старой
  // сборки неизвестен versionCode Android) откат обрывался ПОСЕРЕДИНЕ:
  // latest.yml уже переписан на старую версию, android.json ещё на новой, а
  // админ видит ошибку и уверен, что не произошло ничего. Поймано при первой
  // же живой проверке.
  const planned = [];
  const changed = [];
  const skipped = [];

  if (target.windows) {
    const file = path.join(UPDATES_DIR, target.windows);
    const stat = fs.statSync(file);
    const sha512 = sha512Base64(file);
    // Формат electron-updater. Дату берём от самого файла: она попадает в
    // сравнение с расписанием установки, и «сейчас» тут было бы неправдой —
    // сборка старая.
    planned.push({
      platform: 'Windows',
      name: 'latest.yml',
      content: [
        `version: ${version}`,
        'files:',
        `  - url: ${target.windows}`,
        `    sha512: ${sha512}`,
        `    size: ${stat.size}`,
        `path: ${target.windows}`,
        `sha512: ${sha512}`,
        `releaseDate: '${stat.mtime.toISOString()}'`,
        '',
      ].join('\n'),
    });
  }

  if (target.android) {
    const versionCode = target.androidVersionCode;
    if (Number.isInteger(versionCode)) {
      planned.push({
        platform: 'Android',
        name: 'android.json',
        content: `${JSON.stringify({
          versionCode,
          versionName: version,
          url: `https://cagrizzz.ru/miraschat/updates/${target.android}`,
          size: fs.statSync(path.join(UPDATES_DIR, target.android)).size,
        }, null, 2)}\n`,
      });
    } else {
      // Не отказ всего отката, а пропуск одной платформы: откатить Windows,
      // оставив Android как есть, — законное состояние (на Android откат и
      // так доступен только новым установкам). Но сказать об этом надо прямо.
      skipped.push('Android (неизвестен versionCode — сборка выложена до появления реестра)');
    }
  }

  if (target.deb || target.targz) {
    const existing = readJson('linux.json') || {};
    const debFile = target.deb ? path.join(UPDATES_DIR, target.deb) : null;
    planned.push({
      platform: 'Linux',
      name: 'linux.json',
      content: `${JSON.stringify({
        version,
        ...(target.deb ? { url: `https://cagrizzz.ru/miraschat/updates/${target.deb}` } : {}),
        ...(target.targz ? { archiveUrl: `https://cagrizzz.ru/miraschat/updates/${target.targz}` } : {}),
        ...(debFile ? { size: fs.statSync(debFile).size } : {}),
        // minGlibc — свойство сборки, а не версии: переносим как есть.
        ...(existing.minGlibc ? { minGlibc: existing.minGlibc } : {}),
      }, null, 2)}\n`,
    });
  }

  if (!planned.length) {
    throw new ReleaseError(skipped.length
      ? `Откатить ${version} не на что: ${skipped.join('; ')}`
      : 'У этой версии нет ни одной сборки для раздачи');
  }

  for (const item of planned) {
    fs.writeFileSync(path.join(UPDATES_DIR, item.name), item.content, 'utf8');
    changed.push(item.platform);
  }

  return { version, changed, skipped, state: listReleases() };
}

module.exports = { listReleases, activateRelease, ReleaseError, UPDATES_DIR };
