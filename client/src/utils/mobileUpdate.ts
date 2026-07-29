import { App as CapApp } from '@capacitor/app';
import { isNativeMobile } from './mobileNotify';

// Android не даёт приложениям ставить APK молча — в отличие от десктопа, где
// обновление накатывается само. Максимум, что можно: узнать о новой версии и
// открыть ссылку на неё; дальше решает система и человек. Поэтому здесь всего
// одна кнопка, и обойтись без неё нельзя.
//
// Обновляется именно APK целиком: веб-часть упакована внутрь него, отдельно
// её подменить нечем.
export interface MobileUpdateInfo {
  versionName: string;
  url: string;
}

interface Manifest {
  versionCode: number;
  versionName: string;
  url: string;
}

// Манифест лежит рядом с обновлениями десктопа. Адрес выводим из базового
// URL API, чтобы хост не был прописан в приложении вторым местом.
function manifestUrl(): string | null {
  const apiBase = process.env.REACT_APP_API_BASE_URL;
  if (!apiBase) return null;
  try {
    return new URL('../updates/android.json', `${apiBase.replace(/\/+$/, '')}/`).toString();
  } catch {
    return null;
  }
}

/**
 * Есть ли версия новее установленной. null — обновляться не нужно либо
 * проверить не удалось.
 *
 * Сравниваем versionCode, а не versionName: имя версии — просто подпись для
 * человека, а Android отказывается ставить APK с кодом меньше установленного,
 * так что именно код определяет, что новее.
 */
export async function checkMobileUpdate(): Promise<MobileUpdateInfo | null> {
  if (!isNativeMobile) return null;

  const url = manifestUrl();
  if (!url) return null;

  try {
    const [info, response] = await Promise.all([CapApp.getInfo(), fetch(url, { cache: 'no-store' })]);
    if (!response.ok) return null;

    const manifest: Manifest = await response.json();
    const installed = Number(info.build);
    if (!Number.isFinite(installed) || !(manifest.versionCode > installed)) return null;

    return { versionName: manifest.versionName, url: manifest.url };
  } catch {
    // Сети нет или манифест не выложен — молчим, это не ошибка человека.
    return null;
  }
}

/**
 * Ссылка на APK для QR-кода в Настройках на ПК — не зависит от платформы и
 * не сравнивается с уже установленной версией: она нужна и тому, у кого
 * Android-приложения ещё нет вовсе.
 */
export async function fetchApkDownloadInfo(): Promise<MobileUpdateInfo | null> {
  const url = manifestUrl();
  if (!url) return null;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const manifest: Manifest = await response.json();
    return { versionName: manifest.versionName, url: manifest.url };
  } catch {
    return null;
  }
}

/** Номер установленной версии для показа в настройках. */
export async function mobileVersionName(): Promise<string | null> {
  if (!isNativeMobile) return null;
  try {
    return (await CapApp.getInfo()).version;
  } catch {
    return null;
  }
}

/**
 * Открыть ссылку на APK. Capacitor отдаёт внешний адрес системному браузеру,
 * тот скачивает файл, дальше установку предлагает сам Android.
 */
export function openMobileUpdate(url: string): void {
  window.open(url, '_blank');
}
