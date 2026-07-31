import api from '../api/client';
import { isNativeMobile } from './mobileNotify';
import { mobileVersionName } from './mobileUpdate';
import { APP_VERSION } from '../version';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// Компьютеры, автозапускающие приложение при включении, иногда поднимают его
// раньше, чем в системе появится сеть (Wi-Fi/VPN ещё не подключились) — первая
// попытка отчитаться о версии в этот момент молча проваливается, а вызывается
// reportAppVersion() только один раз за сессию (при появлении user в App.tsx),
// так что без повторов панель управления застревала бы на прошлой версии до
// следующего перезапуска приложения. Три попытки с растущей паузой покрывают
// типичное время, за которое сеть на машине успевает подняться.
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

async function postVersion(
  platform: 'desktop' | 'android' | 'web',
  version: string,
  attempt = 0
): Promise<void> {
  try {
    await api.post('/session/version', { platform, version });
  } catch {
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => postVersion(platform, version, attempt + 1), RETRY_DELAYS_MS[attempt]);
    }
    // Дальше молчим намеренно: это телеметрия, показывать человеку ошибку не нужно.
  }
}

/**
 * Сообщить серверу, какая версия приложения стоит у этого человека, — чтобы в
 * панели управления было видно, до кого обновление доехало, а до кого нет.
 *
 * У веба своего номера версии нет, поэтому отправляем хэш сборки: он тоже
 * отвечает на вопрос «что у него сейчас», просто в другой системе координат.
 */
export async function reportAppVersion(): Promise<void> {
  try {
    let platform: 'desktop' | 'android' | 'web' = 'web';
    let version: string | null = APP_VERSION;

    if (isElectron) {
      platform = 'desktop';
      version = await window.electronAPI!.getAppVersion();
    } else if (isNativeMobile) {
      platform = 'android';
      version = await mobileVersionName();
    }

    if (!version) return;
    await postVersion(platform, version);
  } catch {
    // Молчим намеренно: получить версию у нативного моста тоже может не
    // получиться, и это тоже не повод что-то показывать человеку.
  }
}
