const fs = require('fs');
const path = require('path');

// Манифест, по которому Android-клиент узнаёт о новой версии. Собирается из
// того же build.gradle, откуда берутся номера при сборке APK: писать их сюда
// руками — значит рано или поздно разослать манифест, который обещает версию,
// не совпадающую с лежащим рядом файлом.
//
// Запускать после сборки APK: node scripts/make-update-manifest.js

const GRADLE_PATH = path.join(__dirname, '..', 'android', 'app', 'build.gradle');
const RELEASE_DIR = path.join(__dirname, '..', 'release');

// Базовый адрес раздачи берём из настроек обновления десктопа — файлы лежат в
// одном каталоге, и хост не должен быть прописан в проекте дважды.
const BASE_URL = require(path.join(__dirname, '..', '..', 'desktop', 'package.json')).build.publish[0].url;

const gradle = fs.readFileSync(GRADLE_PATH, 'utf8');
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];

if (!Number.isFinite(versionCode) || !versionName) {
  console.error('Не удалось прочитать versionCode/versionName из', GRADLE_PATH);
  process.exit(1);
}

const apkName = `MirasChat-${versionName}-debug.apk`;
const apkPath = path.join(RELEASE_DIR, apkName);

if (!fs.existsSync(apkPath)) {
  console.error('APK не найден:', apkPath);
  console.error('Сначала соберите его — см. README, «Сборка Android-приложения».');
  process.exit(1);
}

const manifest = {
  versionCode,
  versionName,
  url: new URL(apkName, BASE_URL).toString(),
  size: fs.statSync(apkPath).size,
};

const manifestPath = path.join(RELEASE_DIR, 'android.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log('Манифест обновления:', manifestPath);
console.log(manifest);
