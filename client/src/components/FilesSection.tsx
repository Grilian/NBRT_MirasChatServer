import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';
import { formatChatListTime } from '../utils/time';
import { fileGlyph, formatFileSize } from '../utils/fileLimits';
import { downloadFile } from '../utils/downloadFile';
import ImageLightbox from './ImageLightbox';

// Раздел «Файлы» — личное хранилище: всё, что человек отправил сам, из всех
// переписок сразу.
//
// Отличается от вкладки вложений в карточке чата тем, ЗАЧЕМ сюда приходят:
// там ищут файл конкретного собеседника, здесь — распоряжаются своим (найти,
// скачать, убрать лишнее). Поэтому здесь есть поиск, сортировка, сводка по
// занятому месту и массовые действия, а в карточке чата их нет.

export type FileCategory = 'documents' | 'files' | 'images' | 'music';
type SortKey = 'new' | 'old' | 'big' | 'name';

interface FileItem {
  message_id: number;
  kind: 'image' | 'document';
  name: string;
  path: string;
  size: number | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  category: FileCategory;
  created_at: string;
  chat_id: string;
  chat_name: string;
  chat_kind: string;
  archived_at: number | null;
  can_open: boolean;
}

interface Summary {
  total_bytes: number;
  documents_count: number;
  images_count: number;
  archived_count: number;
  bytes_by_category: Record<FileCategory, number>;
  count_by_category: Record<FileCategory, number>;
}

interface Props {
  /** Открыть переписку на сообщении, с которым пришёл файл. */
  onOpenMessage?: (chatId: string, messageId: number) => void;
}

const CATEGORIES: { id: FileCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'documents', label: 'Документы' },
  { id: 'images', label: 'Изображения' },
  { id: 'music', label: 'Музыка' },
  { id: 'files', label: 'Файлы' },
];

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'new', label: 'Сначала новые' },
  { id: 'old', label: 'Сначала старые' },
  { id: 'big', label: 'Сначала большие' },
  { id: 'name', label: 'По имени' },
];

// Цвет полосы у категории — тот же, что у чипа: полоса занятого места читается
// только если её куски узнаются по цвету без подписи.
const CATEGORY_COLOR: Record<FileCategory, string> = {
  documents: 'var(--accent)',
  images: '#7c9cc4',
  music: '#c48ba0',
  files: '#9aa7a0',
};

/** «1 файл / 2 файла / 5 файлов» — иначе подпись раздела читается коряво. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const icon = (...paths: string[]) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);

const FilesSection: React.FC<Props> = ({ onOpenMessage }) => {
  const [items, setItems] = useState<FileItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [category, setCategory] = useState<FileCategory | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('new');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{ item: FileItem; x: number; y: number } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchApplied, setSearchApplied] = useState('');

  // Поиск не дёргает сервер на каждую букву: список свой, а не общий, и
  // задержки в четверть секунды человек не замечает.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearchApplied(search.trim()), 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/files', { params: { sort, search: searchApplied, archived: showArchived ? 1 : 0 } }),
      api.get('/files/summary'),
    ])
      .then(([list, totals]) => {
        setItems(list.data.items || []);
        setSummary(totals.data);
        setError('');
      })
      .catch(() => setError('Не удалось загрузить файлы'))
      .finally(() => setLoading(false));
  }, [sort, searchApplied, showArchived]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Смена раздела или фильтра сбрасывает выбор: галочки, оставшиеся от
  // прошлого списка, привели бы к удалению не того, что видно на экране.
  useEffect(() => { setSelected(new Set()); }, [category, showArchived, searchApplied]);

  const visible = useMemo(
    () => (category === 'all' ? items : items.filter((item) => item.category === category)),
    [items, category]
  );

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const download = async (item: FileItem) => {
    setNotice('Скачивание…');
    const result = await downloadFile(resolveUploadUrl(item.path), item.name);
    setNotice(result.ok ? `Сохранено в «${result.location}»` : (result.error || 'Не удалось скачать'));
  };

  const archive = async (targets: FileItem[]) => {
    const one = targets.length === 1;
    const question = one
      ? `Удалить «${targets[0].name}»?`
      : `Удалить выбранные файлы (${targets.length})?`;
    // Спрашиваем коротко — по требованию пользователя: только «уверены или нет».
    if (!window.confirm(question)) return;

    const done: number[] = [];
    let failed = 0;
    for (const item of targets) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.post(`/messages/${item.message_id}/attachment/archive`);
        done.push(item.message_id);
      } catch {
        failed += 1;
      }
    }

    setItems((prev) => prev.filter((item) => !done.includes(item.message_id)));
    setSelected(new Set());
    setNotice(failed
      ? `Убрано: ${done.length}, не удалось: ${failed}`
      : (one ? 'Файл убран в архив' : `Убрано файлов: ${done.length}`));
    // Сводка занятого места после удаления обязана пересчитаться — ради неё
    // сюда и приходят.
    api.get('/files/summary').then(({ data }) => setSummary(data)).catch(() => {});
  };

  const openMenu = (item: FileItem, x: number, y: number) => {
    setMenuFor({ item, x: Math.min(x, window.innerWidth - 210), y: Math.min(y, window.innerHeight - 200) });
  };

  const selectedItems = visible.filter((item) => selected.has(item.message_id));
  const totalShown = visible.length;

  const usageBar = summary && summary.total_bytes > 0 ? (
    <div className="files-usage">
      <div className="files-usage-bar">
        {(Object.keys(CATEGORY_COLOR) as FileCategory[]).map((key) => {
          const share = summary.bytes_by_category[key] / summary.total_bytes;
          if (!share) return null;
          return (
            <span
              key={key}
              className="files-usage-part"
              style={{ width: `${share * 100}%`, background: CATEGORY_COLOR[key] }}
              title={`${CATEGORIES.find((c) => c.id === key)?.label}: ${formatFileSize(summary.bytes_by_category[key])}`}
            />
          );
        })}
      </div>
      <div className="files-usage-legend">
        {(Object.keys(CATEGORY_COLOR) as FileCategory[]).map((key) => (
          summary.bytes_by_category[key] ? (
            <span key={key} className="files-usage-item">
              <i style={{ background: CATEGORY_COLOR[key] }} />
              {CATEGORIES.find((c) => c.id === key)?.label} · {formatFileSize(summary.bytes_by_category[key])}
            </span>
          ) : null
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div className="files-section">
      <header className="files-head">
        <div className="files-head-main">
          <h1>Файлы</h1>
          <p className="files-head-sub">
            {summary
              ? `${summary.documents_count + summary.images_count} ${plural(
                summary.documents_count + summary.images_count, 'файл', 'файла', 'файлов'
              )} из ваших сообщений${summary.total_bytes ? ` · ${formatFileSize(summary.total_bytes)}` : ''}`
              : 'Всё, что вы отправляли в переписках'}
          </p>
        </div>
        {summary && summary.archived_count > 0 && (
          <button
            type="button"
            className={'files-archive-toggle' + (showArchived ? ' is-active' : '')}
            onClick={() => setShowArchived((prev) => !prev)}
          >
            {icon('M3 7h18v3H3z', 'M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9', 'M10 14h4')}
            Архив · {summary.archived_count}
          </button>
        )}
      </header>

      {usageBar}

      <div className="files-toolbar">
        <div className="files-search">
          {icon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm21 21-4.3-4.3')}
          <input
            type="text"
            value={search}
            placeholder="Поиск по названию"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="files-search-clear" onClick={() => setSearch('')} aria-label="Очистить поиск">
              ✕
            </button>
          )}
        </div>

        <select
          className="files-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Порядок"
        >
          {SORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>

        <div className="files-view" role="group" aria-label="Вид списка">
          <button
            type="button"
            className={view === 'list' ? 'is-active' : ''}
            onClick={() => setView('list')}
            aria-label="Списком"
            title="Списком"
          >
            {icon('M4 6h16', 'M4 12h16', 'M4 18h16')}
          </button>
          <button
            type="button"
            className={view === 'grid' ? 'is-active' : ''}
            onClick={() => setView('grid')}
            aria-label="Плиткой"
            title="Плиткой"
          >
            {icon('M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z')}
          </button>
        </div>
      </div>

      <div className="files-categories">
        {CATEGORIES.map((item) => {
          const count = item.id === 'all'
            ? (summary ? summary.documents_count + summary.images_count : items.length)
            : (summary ? summary.count_by_category[item.id] : 0);
          return (
            <button
              key={item.id}
              type="button"
              className={'files-chip' + (category === item.id ? ' is-active' : '')}
              onClick={() => setCategory(item.id)}
              aria-pressed={category === item.id}
            >
              {item.label}
              {!showArchived && <span className="files-chip-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Панель массовых действий появляется только когда есть что делать —
          пустая строка кнопок над списком читалась бы как неработающая. */}
      {selectedItems.length > 0 && (
        <div className="files-bulk">
          <span>Выбрано: {selectedItems.length}</span>
          <button type="button" onClick={() => selectedItems.forEach((item) => download(item))}>
            Скачать
          </button>
          {!showArchived && (
            <button type="button" className="is-danger" onClick={() => archive(selectedItems)}>
              Удалить
            </button>
          )}
          <button type="button" className="is-ghost" onClick={() => setSelected(new Set())}>
            Снять выбор
          </button>
        </div>
      )}

      {notice && <div className="files-notice" role="status">{notice}</div>}

      <div className="files-body">
        {loading && <div className="files-empty">Загрузка…</div>}
        {!loading && error && <div className="files-empty">{error}</div>}
        {!loading && !error && totalShown === 0 && (
          <div className="files-empty">
            {showArchived
              ? 'В архиве пусто'
              : searchApplied
                ? `По запросу «${searchApplied}» ничего не нашлось`
                : 'Вы ещё ничего не отправляли. Файлы из ваших сообщений появятся здесь.'}
          </div>
        )}

        {!loading && !error && totalShown > 0 && (
          <div className={view === 'grid' ? 'files-grid' : 'files-list'}>
            {visible.map((item) => {
              const url = resolveUploadUrl(item.path);
              const isSelected = selected.has(item.message_id);
              return (
                <div
                  key={item.message_id}
                  className={'files-item' + (isSelected ? ' is-selected' : '') + (item.archived_at ? ' is-archived' : '')}
                  onContextMenu={(e) => { e.preventDefault(); openMenu(item, e.clientX, e.clientY); }}
                >
                  <label className="files-item-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(item.message_id)}
                      aria-label={`Выбрать ${item.name}`}
                    />
                  </label>

                  <button
                    type="button"
                    className="files-item-main"
                    onClick={() => {
                      if (item.archived_at) return; // файла больше нет — открывать нечего
                      if (item.kind === 'image' && url) setLightboxUrl(url);
                      else download(item);
                    }}
                  >
                    <span className="files-item-preview">
                      {item.kind === 'image' && !item.archived_at && url
                        ? <img src={url} alt="" loading="lazy" decoding="async" />
                        : <span className="files-item-glyph">{item.archived_at ? '🗄' : fileGlyph(item.name)}</span>}
                    </span>
                    <span className="files-item-body">
                      <span className="files-item-name">{item.name}</span>
                      <span className="files-item-meta">
                        {item.size ? `${formatFileSize(item.size)} · ` : ''}
                        {item.chat_name} · {formatChatListTime(item.created_at)}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="files-item-more"
                    aria-label={`Действия с ${item.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      openMenu(item, rect.right - 8, rect.bottom + 4);
                    }}
                  >
                    {icon('M12 6h.01', 'M12 12h.01', 'M12 18h.01')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menuFor && (
        <>
          <div
            className="attachments-menu-backdrop"
            onClick={() => setMenuFor(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenuFor(null); }}
          />
          <div className="attachments-menu" style={{ left: menuFor.x, top: menuFor.y }}>
            {!menuFor.item.archived_at && (
              <button type="button" onClick={() => { const item = menuFor.item; setMenuFor(null); download(item); }}>
                Скачать
              </button>
            )}
            {menuFor.item.can_open && onOpenMessage && (
              <button
                type="button"
                onClick={() => {
                  const item = menuFor.item;
                  setMenuFor(null);
                  onOpenMessage(item.chat_id, item.message_id);
                }}
              >
                Перейти к сообщению
              </button>
            )}
            {!menuFor.item.archived_at && (
              <button
                type="button"
                className="is-danger"
                onClick={() => { const item = menuFor.item; setMenuFor(null); archive([item]); }}
              >
                Удалить
              </button>
            )}
            {menuFor.item.archived_at && (
              <span className="attachments-menu-info">Файл в архиве — вернуть может администратор</span>
            )}
          </div>
        </>
      )}

      {lightboxUrl && <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
};

export default FilesSection;
