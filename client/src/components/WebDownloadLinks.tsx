import React, { useEffect, useState } from 'react';
import { isNativeMobile } from '../utils/mobileNotify';

const UPDATES_ROOT = '/miraschat/updates/';

type DownloadLinks = {
  windows?: string;
  android?: string;
  linux?: string;
};

function updateUrl(fileName: string) {
  return new URL(`${UPDATES_ROOT}${fileName}`, window.location.origin).toString();
}

/** Ссылки только для браузерной версии; Electron и Android обновляются сами. */
const WebDownloadLinks: React.FC = () => {
  const [links, setLinks] = useState<DownloadLinks>({});
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  useEffect(() => {
    if (isElectron || isNativeMobile) return;

    const controller = new AbortController();
    Promise.allSettled([
      fetch(updateUrl('latest.yml'), { signal: controller.signal, cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`latest.yml: ${response.status}`);
          return response.text();
        })
        .then((manifest) => {
          const fileName = manifest.match(/^path:\s*(.+)$/m)?.[1]?.trim();
          if (!fileName) throw new Error('В latest.yml отсутствует path');
          return updateUrl(fileName);
        }),
      fetch(updateUrl('android.json'), { signal: controller.signal, cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`android.json: ${response.status}`);
          return response.json();
        })
        .then((manifest: { url?: string }) => {
          if (!manifest.url) throw new Error('В android.json отсутствует url');
          return new URL(manifest.url, window.location.origin).toString();
        }),
      // Astra — Debian-совместимая, поэтому раздаём .deb. Свой манифест, а не
      // общий с Windows: latest.yml принадлежит electron-updater, у него свой
      // формат и своё назначение (автообновление), и дописывать в него чужую
      // платформу значило бы ломать то, чем он на самом деле является.
      fetch(updateUrl('linux.json'), { signal: controller.signal, cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`linux.json: ${response.status}`);
          return response.json();
        })
        .then((manifest: { url?: string }) => {
          if (!manifest.url) throw new Error('В linux.json отсутствует url');
          return new URL(manifest.url, window.location.origin).toString();
        }),
    ]).then(([windows, android, linux]) => {
      if (controller.signal.aborted) return;
      setLinks({
        windows: windows.status === 'fulfilled' ? windows.value : undefined,
        android: android.status === 'fulfilled' ? android.value : undefined,
        linux: linux.status === 'fulfilled' ? linux.value : undefined,
      });
    });

    return () => controller.abort();
  }, [isElectron]);

  if (isElectron || isNativeMobile) return null;

  return (
    <div className="web-download-links" aria-label="Скачать приложение">
      <a
        className={links.windows ? '' : 'is-disabled'}
        href={links.windows || undefined}
        aria-disabled={!links.windows}
        title="Скачать последнюю версию для Windows"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.2 10.4 4v7.1H3V5.2Zm8.4-1.4L21 2.4v8.7h-9.6V3.8ZM3 12.1h7.4v7.1L3 18v-5.9Zm8.4 0H21v8.7l-9.6-1.4v-7.3Z" /></svg>
        <span>Windows</span>
      </a>
      <a
        className={links.android ? '' : 'is-disabled'}
        href={links.android || undefined}
        aria-disabled={!links.android}
        title="Скачать последнюю версию для Android"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.1 7.2-1.5-2.6.8-.5L8 6.8a9.6 9.6 0 0 1 8 0l1.6-2.7.8.5-1.5 2.6A7.8 7.8 0 0 1 20 13.4H4a7.8 7.8 0 0 1 3.1-6.2ZM8.3 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm7.4 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM4 14.4h16v4.1a2 2 0 0 1-2 2h-1v1.1a1 1 0 0 1-2 0v-1.1H9v1.1a1 1 0 0 1-2 0v-1.1H6a2 2 0 0 1-2-2v-4.1Z" /></svg>
        <span>Android</span>
      </a>
      {/* Значок — коробка пакета, а не фирменный знак Astra: рисовать чужой
          логотип по памяти нельзя, а .deb это ровно пакет и есть. */}
      <a
        className={links.linux ? '' : 'is-disabled'}
        href={links.linux || undefined}
        aria-disabled={!links.linux}
        title="Скачать последнюю версию для Astra Linux (пакет .deb)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.9 2.2a2 2 0 0 0-1.8 0L3.7 6 12 10.1 20.3 6l-7.4-3.8Z" /><path d="M21.4 7.6 12.8 11.9v9.7l7.5-3.8a2 2 0 0 0 1.1-1.8V7.6Z" /><path d="M2.6 7.6v8.4c0 .8.4 1.5 1.1 1.8l7.5 3.8v-9.7L2.6 7.6Z" /></svg>
        <span>Astra</span>
      </a>
    </div>
  );
};

export default WebDownloadLinks;
