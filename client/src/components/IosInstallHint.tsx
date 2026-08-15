import React, { useEffect, useState } from 'react';
import { isNativeMobile } from '../utils/mobileNotify';

// Подсказка про ярлык на рабочем столе iPhone.
//
// Установить веб-приложение на iOS программно нельзя: Safari не поддерживает
// ни кнопку установки, ни событие beforeinstallprompt (в отличие от Android,
// где браузер предлагает это сам). Единственный путь — «Поделиться → На экран
// «Домой»», и человек должен о нём узнать. Отсюда подсказка: показать один
// раз, дать закрыть навсегда и больше не мешать.
//
// Всё, что делает ярлык полноэкранным (apple-mobile-web-app-*, manifest), —
// в client/public/index.html; здесь только объяснение для человека.

const DISMISS_KEY = 'miras-ios-install-hint-dismissed';

/** iPhone/iPad в Safari, ещё не с рабочего стола. */
function shouldShowHint(): boolean {
  if (typeof window === 'undefined' || isNativeMobile) return false;
  // В Electron окно и так своё.
  if ((window as any).electronAPI) return false;

  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua)
    // iPadOS 13+ представляется Mac'ом, отличается наличием тача.
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  if (!isIos) return false;

  // Уже открыто ярлыком — подсказывать нечего.
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (window.navigator as any).standalone === true;
  if (standalone) return false;

  // Chrome и Firefox на iOS — это тот же WebKit, но пункта «На экран «Домой»»
  // у них в меню нет: советовать его там значит послать человека искать то,
  // чего он не найдёт.
  const isSafari = !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/.test(ua);
  if (!isSafari) return false;

  try {
    return window.localStorage.getItem(DISMISS_KEY) !== '1';
  } catch {
    return true;
  }
}

const IosInstallHint: React.FC = () => {
  // Считаем один раз при монтировании: userAgent и режим показа по ходу
  // работы не меняются, а перерасчёт на каждый рендер — лишняя работа.
  const [visible, setVisible] = useState(false);
  useEffect(() => { setVisible(shouldShowHint()); }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* приватный режим */ }
  };

  return (
    <div className="ios-install-hint" role="note">
      <div className="ios-install-hint-body">
        <strong>Добавьте MirasChat на экран «Домой»</strong>
        <span>
          Нажмите{' '}
          <svg viewBox="0 0 24 24" aria-label="Поделиться" role="img">
            <path d="M12 3v12" /><path d="m8 7 4-4 4 4" />
            <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
          </svg>{' '}
          внизу Safari и выберите «На экран «Домой»». Приложение откроется без
          адресной строки, как обычное.
        </span>
      </div>
      <button type="button" className="ios-install-hint-close" onClick={dismiss} aria-label="Больше не показывать">
        ✕
      </button>
    </div>
  );
};

export default IosInstallHint;
