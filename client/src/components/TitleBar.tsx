import React, { useEffect, useState } from 'react';

// Рендерится только внутри Electron (window.electronAPI появляется из preload.js).
// В обычной веб-версии этот файл просто не монтируется — родной хром браузера остаётся как есть.
export default function TitleBar() {
  const api = window.electronAPI!;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    api.isMaximized().then(setIsMaximized);
    const unsubscribe = api.onMaximizedChange(setIsMaximized);
    return unsubscribe;
  }, [api]);

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <span className="roundel roundel-sm">М</span>
        <span className="titlebar-title">MirasChat</span>
      </div>
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          aria-label="Свернуть"
          onClick={() => api.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button
          className="titlebar-btn"
          aria-label={isMaximized ? 'Восстановить' : 'Развернуть'}
          onClick={() => api.toggleMaximize()}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1.5" y="0" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="0" y="2.5" width="7" height="7" fill="var(--accent)" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          aria-label="Закрыть"
          onClick={() => api.close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
