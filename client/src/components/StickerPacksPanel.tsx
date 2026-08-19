import React, { useEffect, useState } from 'react';
import superAdminApi from '../api/superAdminClient';
import { resolveUploadUrl } from '../utils/uploads';
import { useDragReorder } from '../utils/useDragReorder';

// Управление стикерпаками в панели администратора.
//
// Три уровня, как требует задача: список наборов → просмотр набора →
// редактирование. Именно ЭКРАНАМИ, а не аккордеоном (как сделано у смайликов):
// у стикеров есть обложка и обязательный эмодзи у каждого элемента, и всё это
// в раскрывающуюся секцию списка не помещается, не превращая её в кашу.
//
// Отдельным файлом, а не внутри SuperAdminApp.tsx: там уже две тысячи строк, и
// дописывать в него ещё четыреста — делать плохое хуже.

export interface StickerItem {
  id: number;
  file_path: string;
  animated_path: string | null;
  emoji: string;
  retired?: boolean;
}

export interface StickerPack {
  id: number;
  name: string;
  cover_path: string | null;
  enabled: boolean;
  items: StickerItem[];
}

// Служебный пак для стикеров из удалённых наборов — заводится сервером,
// удалять и включать его нельзя (см. routes/stickers.js).
const ARCHIVE_PACK_NAME = 'Архив стикеров';

// Заготовка для эмодзи при загрузке набором. Спрашивать эмодзи на каждый файл
// из полусотни — это полсотни диалогов; проставить настоящие удобнее в сетке.
const DEFAULT_ITEM_EMOJI = '🙂';

export default function StickerPacksPanel() {
  const [packs, setPacks] = useState<StickerPack[]>([]);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  // Какой набор открыт и в каком режиме. null — экран списка.
  const [openPackId, setOpenPackId] = useState<number | null>(null);
  const [editMode, setEditMode] = useState(false);

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/stickers/admin');
      setPacks(data);
      setError('');
    } catch {
      setError('Не удалось загрузить стикерпаки');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const apply = (data: StickerPack[]) => { setPacks(data); setError(''); };
  const fail = (err: any, fallback: string) => setError(err?.response?.data?.error || fallback);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { data } = await superAdminApi.post('/stickers/admin', { name });
      apply(data);
      setNewName('');
    } catch (err: any) {
      fail(err, 'Не удалось создать набор');
    } finally {
      setBusy(false);
    }
  };

  const update = async (id: number, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const { data } = await superAdminApi.put(`/stickers/admin/${id}`, patch);
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const removePack = async (pack: StickerPack) => {
    const message = pack.items.length
      ? `Удалить набор «${pack.name}»? Его стикеры (${pack.items.length}) переедут в архив — сообщения с ними не сломаются.`
      : `Удалить набор «${pack.name}»?`;
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      const { data } = await superAdminApi.delete(`/stickers/admin/${pack.id}`);
      apply(data);
      setOpenPackId(null);
      setEditMode(false);
    } catch (err: any) {
      fail(err, 'Не удалось удалить набор');
    } finally {
      setBusy(false);
    }
  };

  const uploadCover = async (packId: number, file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('image', file);
      const { data } = await superAdminApi.post(`/stickers/admin/${packId}/cover`, form);
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось загрузить обложку');
    } finally {
      setBusy(false);
    }
  };

  const uploadItems = async (packId: number, files: File[]) => {
    setBusy(true);
    const failed: string[] = [];
    let latest: StickerPack[] | null = null;
    // Последовательно, а не пачкой: сервер отдаёт полный список наборов на
    // каждую загрузку, и параллельные ответы перетирали бы друг друга.
    for (const file of files) {
      try {
        const form = new FormData();
        form.append('image', file);
        form.append('emoji', DEFAULT_ITEM_EMOJI);
        const { data } = await superAdminApi.post(`/stickers/admin/${packId}/items`, form);
        latest = data.packs;
      } catch (err: any) {
        failed.push(`${file.name}: ${err.response?.data?.error || 'ошибка загрузки'}`);
      }
    }
    if (latest) apply(latest);
    setError(failed.length ? `Не загружено (${failed.length}): ${failed.join('; ')}` : '');
    setBusy(false);
  };

  const setItemEmoji = async (itemId: number, emoji: string) => {
    try {
      const { data } = await superAdminApi.put(`/stickers/admin/items/${itemId}`, { emoji });
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось сохранить эмодзи');
    }
  };

  const replaceItemImage = async (itemId: number, file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('image', file);
      const { data } = await superAdminApi.post(`/stickers/admin/items/${itemId}/image`, form);
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось заменить картинку');
    } finally {
      setBusy(false);
    }
  };

  // Цена удаления видна ДО нажатия: стикер мог уехать в отправленные
  // сообщения, и там на его месте останется эмодзи-заглушка.
  const removeItem = async (item: StickerItem) => {
    let used = 0;
    try {
      const { data } = await superAdminApi.get(`/stickers/admin/items/${item.id}/usage`);
      used = Number(data.count) || 0;
    } catch {
      // Не смогли посчитать — спросим без числа, это лучше, чем не спросить.
    }
    const warning = used
      ? `Удалить стикер? Он встречается в ${used} сообщениях — там вместо картинки останется эмодзи ${item.emoji}.`
      : 'Удалить стикер?';
    if (!window.confirm(warning)) return;
    setBusy(true);
    try {
      const { data } = await superAdminApi.delete(`/stickers/admin/items/${item.id}`);
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось удалить стикер');
    } finally {
      setBusy(false);
    }
  };

  const saveOrder = async (packId: number, order: number[]) => {
    try {
      const { data } = await superAdminApi.put(`/stickers/admin/${packId}/items/reorder`, { order });
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось сохранить порядок');
    }
  };

  const savePackOrder = async (order: number[]) => {
    try {
      const { data } = await superAdminApi.put('/stickers/admin/reorder', { order });
      apply(data);
    } catch (err: any) {
      fail(err, 'Не удалось сохранить порядок наборов');
      void load();
    }
  };

  const {
    order: packOrder,
    dragId: draggedPackId,
    containerRef: packListRef,
    tileHandlers: packDragHandlers,
  } = useDragReorder({
    items: packs,
    onReorder: savePackOrder,
    dataAttribute: 'data-sticker-pack-id',
  });

  const openPack = packs.find((p) => p.id === openPackId) || null;

  // --- Уровень 1: список наборов ---
  if (!openPack) {
    return (
      <div className="sa-card">
        <h2>Стикерпаки</h2>
        <p className="sa-hint">
          Каждый набор — отдельная вкладка с обложкой в панели стикеров.
          Порядок вкладок меняется перетаскиванием за ручку слева.
        </p>
        {error && <div className="sa-error">{error}</div>}

        <div className="sa-sticker-packs" ref={packListRef}>
          {packOrder.map((pack) => {
            const isArchive = pack.name === ARCHIVE_PACK_NAME;
            return (
              <div
                key={pack.id}
                data-sticker-pack-id={pack.id}
                className={'sa-sticker-pack-card' + (draggedPackId === pack.id ? ' is-dragging' : '')}
              >
                <button
                  type="button"
                  className="sa-pack-drag-handle"
                  aria-label={`Переместить набор ${pack.name}`}
                  title="Перетащить набор"
                  {...packDragHandlers(pack)}
                >
                  ⋮⋮
                </button>
                <button
                  type="button"
                  className="sa-sticker-pack-open"
                  onClick={() => { setOpenPackId(pack.id); setEditMode(false); }}
                >
                  <span className="sa-sticker-pack-cover">
                    {pack.cover_path
                      ? <img src={resolveUploadUrl(pack.cover_path) || ''} alt="" draggable={false} />
                      : <span className="sa-sticker-pack-cover-empty">🖼️</span>}
                  </span>
                  <span className="sa-sticker-pack-meta">
                    <strong>{pack.name}</strong>
                    <span className="sa-hint">
                      {pack.items.length} шт.
                      {!pack.enabled && ' · скрыт'}
                      {isArchive && ' · служебный'}
                    </span>
                  </span>
                </button>
                <div className="sa-sticker-pack-actions">
                  <label className="switch" title={pack.enabled ? 'Показывается' : 'Скрыт'}>
                    <input
                      type="checkbox"
                      checked={pack.enabled}
                      disabled={busy || isArchive}
                      onChange={(e) => update(pack.id, { enabled: e.target.checked })}
                    />
                    <span className="switch-track"><span className="switch-thumb" /></span>
                  </label>
                  {!isArchive && (
                    <button type="button" className="sa-btn-danger" disabled={busy} onClick={() => removePack(pack)}>
                      Удалить
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {packs.length === 0 && <div className="sa-hint">Наборов пока нет</div>}
        </div>

        <form onSubmit={create} className="sa-inline-form">
          <input
            type="text"
            placeholder="Название набора…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy || !newName.trim()}>
            Создать набор стикеров
          </button>
        </form>
      </div>
    );
  }

  const isArchive = openPack.name === ARCHIVE_PACK_NAME;

  // --- Уровни 2 и 3: просмотр набора и его редактирование ---
  return (
    <div className="sa-card">
      <div className="sa-sticker-head">
        <button
          type="button"
          className="sa-btn-ghost"
          onClick={() => { setOpenPackId(null); setEditMode(false); }}
        >
          ← Все наборы
        </button>
        <h2>{openPack.name}</h2>
        {!isArchive && (
          <button
            type="button"
            className={editMode ? 'sa-btn-ghost' : 'btn-primary'}
            onClick={() => setEditMode((v) => !v)}
          >
            {editMode ? 'Готово' : 'Редактировать'}
          </button>
        )}
      </div>
      {error && <div className="sa-error">{error}</div>}

      <div className="sa-sticker-pack-summary">
        <span className="sa-sticker-pack-cover is-large">
          {openPack.cover_path
            ? <img src={resolveUploadUrl(openPack.cover_path) || ''} alt="" draggable={false} />
            : <span className="sa-sticker-pack-cover-empty">🖼️</span>}
        </span>
        <div className="sa-sticker-pack-summary-body">
          {editMode ? (
            <>
              <input
                className="sa-emoji-pack-name"
                defaultValue={openPack.name}
                aria-label="Название набора"
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== openPack.name) update(openPack.id, { name: value });
                }}
              />
              <label className="sa-emoji-custom-add">
                <input
                  type="file" accept="image/*" style={{ display: 'none' }}
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) uploadCover(openPack.id, file);
                  }}
                />
                {openPack.cover_path ? 'Заменить обложку' : 'Выбрать обложку'}
              </label>
            </>
          ) : (
            <span className="sa-hint">
              {openPack.items.length} стикеров{openPack.enabled ? '' : ' · набор скрыт'}
            </span>
          )}
        </div>
      </div>

      {isArchive && (
        <p className="sa-hint">
          Сюда переезжают стикеры из удалённых наборов — они нужны только для
          отрисовки старых сообщений и в пикере не показываются.
        </p>
      )}

      <StickerItemGrid
        items={openPack.items}
        editable={editMode && !isArchive}
        onReorder={(order) => saveOrder(openPack.id, order)}
        onEmojiChange={setItemEmoji}
        onReplaceImage={replaceItemImage}
        onRemove={removeItem}
      />

      {editMode && !isArchive && (
        <div className="sa-emoji-pack-add">
          <label className="sa-emoji-custom-add">
            <input
              type="file" accept="image/*" multiple style={{ display: 'none' }}
              disabled={busy}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = '';
                if (files.length) uploadItems(openPack.id, files);
              }}
            />
            {busy ? 'Загрузка…' : '+ Добавить стикеры'}
          </label>
          <span className="sa-hint">
            Новым стикерам ставится {DEFAULT_ITEM_EMOJI} — поменяйте эмодзи в плитках.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Сетка стикеров. Тот же жест перетаскивания, что у смайликов (общий хук
 * useDragReorder), но плитка крупнее и несёт поле эмодзи: связь стикер↔эмодзи
 * хранится в самих данных набора и задаётся здесь.
 */
function StickerItemGrid({
  items, editable, onReorder, onEmojiChange, onReplaceImage, onRemove,
}: {
  items: StickerItem[];
  editable: boolean;
  onReorder: (order: number[]) => void;
  onEmojiChange: (itemId: number, emoji: string) => void;
  onReplaceImage: (itemId: number, file: File) => void;
  onRemove: (item: StickerItem) => void;
}) {
  const { order, dragId, containerRef, tileHandlers } = useDragReorder({
    items, onReorder, dataAttribute: 'data-sticker-id',
  });

  if (!items.length) return <div className="sa-hint">В наборе пока нет стикеров</div>;

  return (
    <div className="sa-sticker-grid" ref={containerRef}>
      {order.map((item) => (
        <div
          key={item.id}
          data-sticker-id={item.id}
          className={`sa-sticker-tile${dragId === item.id ? ' is-dragging' : ''}`}
          // Перетаскивание только в режиме редактирования: в просмотре сетка
          // должна спокойно прокручиваться.
          {...(editable ? tileHandlers(item) : {})}
        >
          <img src={resolveUploadUrl(item.file_path) || ''} alt={item.emoji} draggable={false} />
          {editable ? (
            <div className="sa-sticker-tile-tools">
              <input
                className="sa-sticker-emoji"
                defaultValue={item.emoji}
                maxLength={32}
                aria-label="Эмодзи стикера"
                // pointerdown не должен доходить до жеста перетаскивания —
                // иначе в поле не поставить курсор и не выделить текст.
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== item.emoji) onEmojiChange(item.id, value);
                }}
              />
              <label
                className="sa-sticker-tile-action"
                title="Заменить картинку"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <input
                  type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) onReplaceImage(item.id, file);
                  }}
                />
                ⟳
              </label>
              <button
                type="button"
                className="sa-sticker-tile-action is-danger"
                title="Удалить стикер"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(item)}
              >
                ×
              </button>
            </div>
          ) : (
            <span className="sa-sticker-tile-emoji">{item.emoji}</span>
          )}
        </div>
      ))}
    </div>
  );
}
