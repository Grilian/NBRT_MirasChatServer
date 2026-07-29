import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { fetchApkDownloadInfo } from '../utils/mobileUpdate';

interface AndroidQrModalProps {
  onClose: () => void;
}

/**
 * QR на ссылку скачивания Android-сборки — код рисуется прямо в браузере
 * (библиотека `qrcode`, без обращения к стороннему сервису генерации): адрес
 * сервера компании незачем передавать наружу ради картинки.
 */
const AndroidQrModal: React.FC<AndroidQrModalProps> = ({ onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState<{ versionName: string; url: string } | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchApkDownloadInfo().then((result) => { if (!cancelled) setInfo(result); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!info || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, info.url, { width: 220, margin: 1 }).catch(console.error);
  }, [info]);

  const handleCopy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер обмена недоступен (нет разрешения/не HTTPS) — ссылка всё равно
      // видна текстом ниже, просто скопировать её придётся вручную.
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Android-приложение</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="qr-modal-body">
          {info === undefined && <div className="roster-empty">Загрузка…</div>}
          {info === null && (
            <div className="roster-empty">Не удалось получить ссылку на установочный файл. Проверьте подключение к сети.</div>
          )}
          {info && (
            <>
              <p className="field-hint qr-modal-hint">Отсканируйте телефоном, чтобы скачать и установить MirasChat для Android.</p>
              <canvas ref={canvasRef} className="qr-modal-canvas" />
              <div className="qr-modal-version">Версия {info.versionName}</div>
              <div className="qr-modal-link-row">
                <input type="text" readOnly value={info.url} onFocus={(e) => e.target.select()} />
                <button type="button" className="sa-btn-ghost" onClick={handleCopy}>{copied ? 'Скопировано' : 'Копировать'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AndroidQrModal;
