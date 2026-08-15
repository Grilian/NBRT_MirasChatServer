import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';
// formatChatListTime, а не formatDate: последняя разбирает дату рождения
// (YYYY-MM-DD), а у сообщения — серверная метка времени.
import { formatChatListTime } from '../utils/time';
import { fileGlyph, formatFileSize } from '../utils/fileLimits';
import { downloadFile } from '../utils/downloadFile';
import ImageLightbox from './ImageLightbox';

// Вложения переписки: «Медиа», «Файлы», «Ссылки».
//
// Отдельный компонент, а не кусок карточки человека: те же вкладки нужны и
// группе, и общему чату, и различаются они только chatId. Данные тянутся одной
// ручкой (GET /messages/:chatId/attachments) — фильтровать уже загруженную
// историю на клиенте нельзя, её там всего одна страница.

export type AttachmentTab = 'media' | 'files' | 'links';
export type FileCategory = 'documents' | 'files' | 'images' | 'music';

interface MediaItem {
  id: number;
  file_path: string;
  file_width: number | null;
  file_height: number | null;
  created_at: string;
  sender_id: number;
}

interface FileItem {
  id: number;
  document_path: string;
  document_name: string | null;
  document_size: number | null;
  category: FileCategory;
  created_at: string;
  sender_id: number;
}

interface LinkItem {
  message_id: number;
  url: string;
  href: string;
  created_at: string;
  sender_id: number;
}

const TABS: { id: AttachmentTab; label: string }[] = [
  { id: 'media', label: 'Медиа' },
  { id: 'files', label: 'Файлы' },
  { id: 'links', label: 'Ссылки' },
];

// Категории внутри «Файлов». «Все» первым: чаще всего человек просто ищет
// недавно присланное и не думает о том, документ это или архив.
const CATEGORIES: { id: FileCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'documents', label: 'Документы' },
  { id: 'files', label: 'Файлы' },
  { id: 'images', label: 'Изображения' },
  { id: 'music', label: 'Музыка' },
];

const EMPTY_TEXT: Record<AttachmentTab, string> = {
  media: 'В этой переписке пока нет изображений',
  files: 'В этой переписке пока нет файлов',
  links: 'В этой переписке пока нет ссылок',
};

const LONG_PRESS_MS = 450;

/** Что открыто в меню: картинка из «Медиа» или файл из «Файлов». */
interface MenuTarget {
  messageId: number;
  mine: boolean;
  url: string | null;
  name: string | null;
  isImage: boolean;
  x: number;
  y: number;
}

interface Props {
  chatId: string;
  currentUserId: number;
  /** Открыть переписку на этом сообщении. Без него пункт меню не показывается. */
  onOpenMessage?: (chatId: string, messageId: number) => void;
}

const ChatAttachments: React.FC<Props> = ({ chatId, currentUserId, onOpenMessage }) => {
  const [tab, setTab] = useState<AttachmentTab>('media');
  const [category, setCategory] = useState<FileCategory | 'all'>('all');
  const [items, setItems] = useState<(MediaItem | FileItem | LinkItem)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api.get(`/messages/${encodeURIComponent(chatId)}/attachments`, { params: { kind: tab } })
      .then(({ data }) => { if (alive) setItems(data.items || []); })
      .catch(() => { if (alive) setError('Не удалось загрузить вложения'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [chatId, tab]);

  useEffect(() => load(), [load]);

  // Уведомление живёт недолго: это подтверждение действия, а не сообщение,
  // которое нужно закрывать руками.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => () => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }, []);

  const openMenu = (target: Omit<MenuTarget, 'x' | 'y'>, x: number, y: number) => {
    // Меню не должно уезжать за нижний край: список вложений сам по себе
    // прокручиваемый, и меню в его конце оказалось бы за экраном.
    setMenu({ ...target, x: Math.min(x, window.innerWidth - 200), y: Math.min(y, window.innerHeight - 180) });
  };

  // Долгое удержание на телефоне и правый клик на ПК ведут в одно меню; обычный
  // тап тоже открывает его (по требованию), поэтому таймер нужен только чтобы
  // не открыть меню дважды.
  const pressHandlers = (target: Omit<MenuTarget, 'x' | 'y'>) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      openMenu(target, e.clientX, e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      longPressFired.current = false;
      const touch = e.touches[0];
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        openMenu(target, touch.clientX, touch.clientY);
      }, LONG_PRESS_MS);
    },
    onTouchMove: () => {
      // Палец поехал — это прокрутка списка, а не удержание.
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    onTouchEnd: () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    onClick: (e: React.MouseEvent) => {
      // Меню уже открыто удержанием — синтетический click после touchend не
      // должен открыть его повторно в другом месте.
      if (longPressFired.current) {
        longPressFired.current = false;
        return;
      }
      openMenu(target, e.clientX, e.clientY);
    },
  });

  const handleDownload = async (target: MenuTarget) => {
    setMenu(null);
    const result = await downloadFile(target.url, target.name);
    setNotice(result.ok ? `Сохранено в «${result.location}»` : (result.error || 'Не удалось скачать'));
  };

  const handleArchive = async (target: MenuTarget) => {
    setMenu(null);
    const what = target.isImage ? 'изображение' : 'файл';
    if (!window.confirm(
      `Удалить ${what} из переписки?\n\n`
      + 'Оно пропадёт у всех участников. На сервере файл не стирается, а '
      + 'убирается в архив — вернуть его сможет только администратор.'
    )) return;

    try {
      await api.post(`/messages/${target.messageId}/attachment/archive`);
      setItems((prev) => prev.filter((item) => ('id' in item ? item.id : item.message_id) !== target.messageId));
      setNotice(target.isImage ? 'Изображение убрано' : 'Файл убран в архив');
    } catch (e: any) {
      setNotice(e?.response?.data?.error || 'Не удалось убрать вложение');
    }
  };

  const visibleFiles = (items as FileItem[]).filter(
    (item) => category === 'all' || item.category === category
  );

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

      {tab === 'files' && (
        <div className="attachments-categories">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={'attachments-category' + (category === item.id ? ' is-active' : '')}
              // Подпись отличается от названия вкладки: «Файлы» есть и там и
              // там, и без уточнения экранная читалка называет их одинаково.
              aria-label={`Категория: ${item.label}`}
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {loading && <div className="user-info-files-empty">Загрузка…</div>}
      {!loading && error && <div className="user-info-files-empty">{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="user-info-files-empty">{EMPTY_TEXT[tab]}</div>
      )}
      {!loading && !error && tab === 'files' && items.length > 0 && visibleFiles.length === 0 && (
        <div className="user-info-files-empty">В этой категории ничего нет</div>
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
                // Картинка декоративная (alt пустой), поэтому имя кнопке даёт
                // подпись: иначе в списке подряд идут безымянные кнопки.
                aria-label={`Изображение от ${formatChatListTime(item.created_at)}`}
                {...pressHandlers({
                  messageId: item.id,
                  mine: item.sender_id === currentUserId,
                  url,
                  name: item.file_path.split('/').pop() || 'image.webp',
                  isImage: true,
                })}
              >
                <img src={url || ''} alt="" loading="lazy" decoding="async" />
              </button>
            );
          })}
        </div>
      )}

      {!loading && !error && tab === 'files' && visibleFiles.length > 0 && (
        <div className="attachments-list">
          {visibleFiles.map((item) => (
            <button
              key={item.id}
              type="button"
              className="attachments-file"
              {...pressHandlers({
                messageId: item.id,
                mine: item.sender_id === currentUserId,
                url: resolveUploadUrl(item.document_path),
                name: item.document_name,
                isImage: false,
              })}
            >
              <span className="attachments-file-glyph" aria-hidden="true">{fileGlyph(item.document_name)}</span>
              <span className="attachments-file-body">
                <span className="attachments-file-name">{item.document_name || 'Файл'}</span>
                <span className="attachments-file-meta">
                  {formatFileSize(item.document_size)} · {formatChatListTime(item.created_at)}
                </span>
              </span>
            </button>
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

      {notice && <div className="attachments-notice">{notice}</div>}

      {menu && (
        <>
          {/* Подложка ловит клик мимо меню — включая правый клик, иначе меню
              осталось бы висеть поверх нового. */}
          <div
            className="attachments-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div className="attachments-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.isImage && (
              <button type="button" onClick={() => { setLightboxUrl(menu.url); setMenu(null); }}>
                Открыть
              </button>
            )}
            {onOpenMessage && (
              <button
                type="button"
                onClick={() => { setMenu(null); onOpenMessage(chatId, menu.messageId); }}
              >
                Перейти к сообщению
              </button>
            )}
            <button type="button" onClick={() => handleDownload(menu)}>Скачать</button>
            {/* Чужое вложение убрать нельзя: в чужой переписке человек — гость,
                и удаление за собеседника ему не принадлежит. */}
            {menu.mine && (
              <button type="button" className="is-danger" onClick={() => handleArchive(menu)}>
                Удалить
              </button>
            )}
          </div>
        </>
      )}

      {lightboxUrl && <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
};

export default ChatAttachments;
