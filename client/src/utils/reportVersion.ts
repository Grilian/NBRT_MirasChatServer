import api from '../api/client';
import { isNativeMobile } from './mobileNotify';
import { mobileVersionName } from './mobileUpdate';
import { APP_VERSION } from '../version';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

/**
 * Сообщить серверу, какая версия приложения стоит у этого человека, — чтобы в
 * панели управления было видно, до кого обновление доехало, а до кого нет.
 *
 * У веба своего номера версии нет, поэтому отправляем хэш сборки: он тоже
 * отвечает на вопрос «что у него сейчас», просто в другой системе координат.
 *
 * Ошибки глотаем молча. Это телеметрия: она не должна ни мешать запуску, ни
 * показывать человеку сообщение о том, что не удалось отчитаться о версии.
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
    await api.post('/session/version', { platform, version });
  } catch {
    // Молчим намеренно.
  }
}
