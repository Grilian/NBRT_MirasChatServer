import React, { useEffect, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';
// formatChatListTime, а не formatDate: последняя разбирает дату рождения
// (YYYY-MM-DD), а у сообщения — серверная метка времени.
import { formatChatListTime } from '../utils/time';
import { fileGlyph, formatFileSize } from '../utils/fileLimits';
import ImageLightbox from './ImageLightbox';

// Вложения переписки: «Медиа», «Файлы», «Ссылки».
//
// Отдельный компонент, а не кусок карточки человека: те же три вкладки нужны
// и группе, и общему чату, и различаются они только chatId. Данные тянутся
// одной ручкой (GET /messages/:chatId/attachments) — фильтровать уже
// загруженную историю на клиенте нельзя, её там всего одна страница.

export type AttachmentTab = 'media' | 'files' | 'links';

interface MediaItem {
  id: number;
  file_path: string;
  file_width: number | null;
  file_height: number | null;
  created_at: string;
}

interface FileItem {
  id: number;
  document_path: string;
  document_name: string | null;
  document_size: number | null;
  created_at: string;
}

interface LinkItem {
  message_id: number;
  url: string;
  href: string;
  created_at: string;
}

const TABS: { id: AttachmentTab; label: string }[] = [
  { id: 'media', label: 'Медиа' },
  { id: 'files', label: 'Файлы' },
  { id: 'links', label: 'Ссылки' },
];

const EMPTY_TEXT: Record<AttachmentTab, string> = {
  media: 'В этой переписке пока нет изображений',
  files: 'В этой переписке пока нет файлов',
  links: 'В этой переписке пока нет ссылок',
};

const ChatAttachments: React.FC<{ chatId: string }> = ({ chatId }) => {
  const [tab, setTab] = useState<AttachmentTab>('media');
  const [items, setItems] = useState<(MediaItem | FileItem | LinkItem)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api.get(`/messages/${encodeURIComponent(chatId)}/attachments`, { params: { kind: tab } })
      .then(({ data }) => { if (alive) setItems(data.items || []); })
      .catch(() => { if (alive) setError('Не удалось загрузить вложения'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [chatId, tab]);

  return (
    <div className="user-info-files">
      <div className="user-info-files-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={'user-info-files-tab' + (tab === item.id ? ' is-active' : '')}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        {/* Голосовых сообщений в приложении ещё нет вовсе — вкладка осталась
            заделом, и честнее показать её выключенной, чем открыть пустой
            список, неотличимый от «ничего не присылали». */}
        <button type="button" className="user-info-files-tab is-planned" disabled title="В разработке">
          Голосовые
        </button>
      </div>

      {loading && <div className="user-info-files-empty">Загрузка…</div>}
      {!loading && error && <div className="user-info-files-empty">{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="user-info-files-empty">{EMPTY_TEXT[tab]}</div>
      )}

      {!loading && !error && tab === 'media' && items.length > 0 && (
        <div className="attachments-media">
          {(items as MediaItem[]).map((item) => {
            const url = resolveUploadUrl(item.file_path);
            return (
              <button
                key={item.id}
                type="button"
                className="attachments-media-cell"
                title={formatChatListTime(item.created_at)}
                onClick={() => url && setLightboxUrl(url)}
              >
                <img src={url || ''} alt="" loading="lazy" decoding="async" />
              </button>
            );
          })}
        </div>
      )}

      {!loading && !error && tab === 'files' && items.length > 0 && (
        <div className="attachments-list">
          {(items as FileItem[]).map((item) => (
            <a
              key={item.id}
              className="attachments-file"
              href={resolveUploadUrl(item.document_path) || undefined}
              download={item.document_name || undefined}
              target="_blank"
              rel="noreferrer"
            >
              <span className="attachments-file-glyph" aria-hidden="true">{fileGlyph(item.document_name)}</span>
              <span className="attachments-file-body">
                <span className="attachments-file-name">{item.document_name || 'Файл'}</span>
                <span className="attachments-file-meta">
                  {formatFileSize(item.document_size)} · {formatChatListTime(item.created_at)}
                </span>
              </span>
            </a>
          ))}
        </div>
      )}

      {!loading && !error && tab === 'links' && items.length > 0 && (
        <div className="attachments-list">
          {(items as LinkItem[]).map((item) => (
            <a
              key={`${item.message_id}-${item.url}`}
              className="attachments-link"
              href={item.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className="attachments-link-url">{item.url}</span>
              <span className="attachments-file-meta">{formatChatListTime(item.created_at)}</span>
            </a>
          ))}
        </div>
      )}

      {lightboxUrl && <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
};

export default ChatAttachments;
