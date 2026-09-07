import React, { useEffect, useMemo, useState } from 'react';
import superAdminApi from '../api/superAdminClient';
import { resolveUploadUrl } from '../utils/uploads';
import { useDragReorder } from '../utils/useDragReorder';

/**
 * Вкладка «Смайлики» панели управления.
 *
 * Экран отвечает на два разных вопроса и потому разделён надвое. Сверху —
 * ЧЕМ показывать: наборы оформления (Apple, Telegram Animation и любые другие),
 * их порядок, включение и загрузка. Снизу — ЧТО показывать: каталог самих
 * смайликов, где у каждого своя строка с настройками.
 *
 * Настройки живут прямо в строке, а не в модалке по нажатию: их немного, они
 * умещаются в ряд, и открывать окно ради одной галочки — лишний шаг в работе,
 * которая по сути состоит из перебора списка.
 */

interface AssetOfItem {
  pack_id: number;
  pack_key: string;
  pack_name: string;
  role: 'base' | 'animation';
  file_path: string;
  enabled: boolean;
  pack_enabled: boolean;
  pack_active: boolean;
}

interface ToneOfItem {
  id: number;
  unicode_key: string;
  unicode: string;
  file_path: string;
  fallback: string;
}

interface CatalogItem {
  id: number;
  name: string;
  emoji: string;
  file_path: string | null;
  animated_path: string | null;
  fallback: string;
  unicode?: string | null;
  unicode_key?: string | null;
  label?: string;
  keywords?: string;
  retired?: boolean;
  assets?: AssetOfItem[];
  tones?: ToneOfItem[];
}

interface CatalogPack {
  id: number;
  name: string;
  enabled: boolean;
  items?: CatalogItem[];
}

interface AssetPack {
  id: number;
  key: string;
  name: string;
  role: 'base' | 'animation';
  enabled: boolean;
  active: boolean;
  item_count: number;
}

interface SystemState {
  assetPacks: AssetPack[];
  structure: { item_count: number; group_count: number };
  logicalItems: number;
}

const ROLE_LABEL = { base: 'Оформление', animation: 'Анимация' } as const;
const NEW_PACK = '__new__';

/** Человеческий код символа: U+1F44D, для составных — через дефис. */
const codeOf = (unicodeKey?: string | null): string => (unicodeKey
  ? unicodeKey.split('-').map((p) => 'U+' + p.toUpperCase()).join(' ')
  : '');

/** Код набора уезжает в имена файлов и в текст сообщений — только латиница. */
const slugFromName = (value: string) => value.trim().toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

type Filter = 'all' | 'off' | 'nobase' | 'animated';

const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'all', label: 'Все', hint: 'Весь каталог' },
  { key: 'off', label: 'Выключенные', hint: 'Убраны из панели выбора' },
  { key: 'nobase', label: 'Без оформления', hint: 'Нет картинки ни в одном базовом наборе' },
  { key: 'animated', label: 'С анимацией', hint: 'Есть версия из анимационного набора' },
];

const EmojiCatalogPanel: React.FC = () => {
  const [packs, setPacks] = useState<CatalogPack[]>([]);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const [openPack, setOpenPack] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<{ id: number; kind: 'tones' | 'assets' } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const PAGE = 300;
  const [shown, setShown] = useState(PAGE);

  const [assetTarget, setAssetTarget] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newRole, setNewRole] = useState<'base' | 'animation'>('base');

  const load = async () => {
    try {
      const [p, s] = await Promise.all([
        superAdminApi.get('/emoji/admin'),
        superAdminApi.get('/emoji/admin/system'),
      ]);
      setPacks(p.data);
      setSystem(s.data);
      setError('');
      if (!assetTarget && s.data.assetPacks[0]) setAssetTarget(s.data.assetPacks[0].key);
    } catch {
      setError('Не удалось загрузить каталог');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // Ручки правки возвращают полный каталог сами, поэтому перечитывать его
  // вторым запросом незачем: выдача весит мегабайты, и на каждое нажатие
  // галочки их уезжало вдвое больше нужного.
  const run = async (tag: string, fn: () => Promise<any>) => {
    setBusy(tag);
    setError('');
    try {
      const res = await fn();
      const body = res?.data;
      const fresh = Array.isArray(body) ? body : body?.packs;
      if (Array.isArray(fresh)) setPacks(fresh);
      if (body?.assetPacks) setSystem((prev) => (prev ? { ...prev, assetPacks: body.assetPacks } : prev));
      if (!Array.isArray(fresh) && !body?.assetPacks) await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось выполнить действие');
    } finally {
      setBusy('');
    }
  };

  // ===== Наборы оформления =====

  const importArchive = async (file: File) => {
    let target: { key: string; name: string; role: string };
    if (assetTarget === NEW_PACK) {
      const key = slugFromName(newKey || newName);
      if (!key) { setError('Укажите код набора латиницей'); return; }
      if (system?.assetPacks.some((p) => p.key === key)) {
        setError(`Набор «${key}» уже есть — выберите его в списке, чтобы обновить картинки`);
        return;
      }
      target = { key, name: newName.trim() || key, role: newRole };
    } else {
      const existing = system?.assetPacks.find((p) => p.key === assetTarget);
      if (!existing) { setError('Набор не найден'); return; }
      target = { key: existing.key, name: existing.name, role: existing.role };
    }

    setBusy('import');
    setError('');
    setNotice(`Загружаем «${target.name}». Большой архив обрабатывается несколько минут.`);
    const form = new FormData();
    form.append('archive', file);
    form.append('key', target.key);
    form.append('name', target.name);
    form.append('role', target.role);
    try {
      const { data } = await superAdminApi.post('/emoji/admin/assets/import', form, { timeout: 30 * 60 * 1000 });
      await load();
      if (assetTarget === NEW_PACK) { setAssetTarget(target.key); setNewName(''); setNewKey(''); }
      setNotice(`Готово: ${data.report.imported} из ${data.report.total}, пропущено ${data.report.skipped}.`);
      if (data.report.errors?.length) setError(data.report.errors.slice(0, 5).join('; '));
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось импортировать набор');
      setNotice('');
    } finally {
      setBusy('');
    }
  };

  const assetPacks = system?.assetPacks || [];
  const packDrag = useDragReorder<AssetPack>({
    items: assetPacks,
    dataAttribute: 'data-asset-pack',
    onReorder: (order) => run('reorder', () => superAdminApi.put('/emoji/admin/assets/reorder', { order })),
  });

  // ===== Каталог =====

  const allItems = useMemo(
    () => packs.flatMap((p) => (p.items || []).map((i) => ({ item: i, pack: p }))),
    [packs],
  );

  const matches = (i: CatalogItem) => {
    if (filter === 'off' && !i.retired) return false;
    if (filter === 'nobase' && (i.assets || []).some((a) => a.role === 'base')) return false;
    if (filter === 'animated' && !(i.assets || []).some((a) => a.role === 'animation')) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLocaleLowerCase('ru');
    return `${i.label || ''} ${i.keywords || ''} ${i.name} ${i.unicode_key || ''} ${i.unicode || i.fallback || ''}`
      .toLocaleLowerCase('ru').includes(q);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setShown(PAGE); }, [openPack, search, filter]);

  const searching = !!search.trim() || filter !== 'all';
  const found = useMemo(
    () => (searching ? allItems.filter(({ item }) => matches(item)).slice(0, 400) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allItems, search, filter],
  );

  const toggleItem = (item: CatalogItem) => run(`item-${item.id}`,
    () => superAdminApi.put(`/emoji/admin/custom/${item.id}/enabled`, { enabled: !!item.retired }));

  const toggleAsset = (item: CatalogItem, asset: AssetOfItem) => run(`asset-${item.id}-${asset.pack_id}`,
    () => superAdminApi.put(`/emoji/admin/assets/${asset.pack_id}/items/${item.id}`, { enabled: !asset.enabled }));

  const removeItem = (item: CatalogItem) => {
    if (!window.confirm(`Удалить «${item.unicode || item.fallback || item.name}» из каталога?\n\n`
      + 'Строка и все её картинки будут стёрты с диска. В уже отправленных сообщениях '
      + 'на месте смайлика останется системный символ.')) return;
    run(`del-${item.id}`, () => superAdminApi.delete(`/emoji/admin/custom/${item.id}`));
  };

  const bulk = (enabled: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    run('bulk', async () => {
      await superAdminApi.put('/emoji/admin/custom/enabled-bulk', { ids, enabled });
      setSelected(new Set());
    });
  };

  const pick = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const visiblePack = packs.find((p) => p.id === openPack);
  const allRows = searching ? found : (visiblePack?.items || []).map((i) => ({ item: i, pack: visiblePack! }));
  // Категории обычно небольшие (самая крупная — «Люди и тело», 393 строки), но
  // структуру могут не загрузить вовсе, и тогда ВЕСЬ каталог падает в один
  // раздел «Другие» — это две с лишним тысячи строк с картинками в каждой.
  // Показываем порциями: пролистать столько всё равно нельзя, а держать их в
  // DOM ради этого незачем.
  const rows = allRows.slice(0, shown);
  const more = allRows.length - rows.length;

  return (
    <div className="sa-emoji">
      {error && <div className="sa-error">{error}</div>}
      {notice && <div className="sa-notice">{notice}</div>}

      {/* ===== ЧЕМ показывать ===== */}
      <section className="sa-emoji-sets">
        <div className="sa-emoji-sets-head">
          <h3>Наборы оформления</h3>
          <p className="sa-hint">
            Порядок решает, откуда взять картинку, если в активном наборе её нет.
            Перетаскиванием — выше значит раньше. Один ZIP — один набор,
            имена внутри вида U+1F600.webp.
          </p>
        </div>

        <div className="sa-asset-packs" ref={packDrag.containerRef}>
          {packDrag.order.map((pack) => (
            <div
              key={pack.id}
              data-asset-pack={pack.id}
              {...packDrag.tileHandlers(pack)}
              className={'sa-asset-pack'
                + (pack.active ? ' is-active' : '')
                + (pack.enabled ? '' : ' is-off')
                + (packDrag.dragId === pack.id ? ' is-dragging' : '')}
            >
              <span className="sa-asset-grip" aria-hidden>⣿</span>
              <div className="sa-asset-main">
                <strong>{pack.name}</strong>
                <small>{ROLE_LABEL[pack.role]} · {pack.item_count} картинок</small>
              </div>

              {pack.role === 'base' && (
                <button
                  type="button"
                  className={'sa-asset-activate' + (pack.active ? ' is-current' : '')}
                  disabled={!!busy || !pack.item_count || !pack.enabled}
                  title={pack.active ? 'Этот набор показывается по умолчанию' : 'Сделать основным'}
                  onClick={() => run(`act-${pack.id}`,
                    () => superAdminApi.put(`/emoji/admin/assets/${pack.id}`, { active: true }))}
                >
                  {pack.active ? 'Основной' : 'Сделать основным'}
                </button>
              )}

              <label className="switch" title={pack.enabled ? 'Набор используется' : 'Набор выключен'}>
                <input
                  type="checkbox"
                  checked={pack.enabled}
                  disabled={!!busy}
                  onChange={() => run(`en-${pack.id}`,
                    () => superAdminApi.put(`/emoji/admin/assets/${pack.id}`, { enabled: !pack.enabled }))}
                />
                <span className="switch-track"><span className="switch-thumb" /></span>
              </label>

              <button
                type="button"
                className="sa-asset-delete"
                title="Удалить набор вместе с картинками"
                disabled={!!busy}
                onClick={() => {
                  if (!window.confirm(`Удалить набор «${pack.name}»?\n\n`
                    + `Все ${pack.item_count} картинок будут стёрты с диска. Сами смайлики останутся — `
                    + 'без этого оформления. Чтобы просто спрятать набор, выключите его.')) return;
                  run(`rm-${pack.id}`, () => superAdminApi.delete(`/emoji/admin/assets/${pack.id}`));
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="sa-emoji-import">
          <select value={assetTarget} onChange={(e) => setAssetTarget(e.target.value)} disabled={!!busy}>
            {assetPacks.map((p) => (
              <option key={p.id} value={p.key}>{p.name} — {ROLE_LABEL[p.role]}</option>
            ))}
            <option value={NEW_PACK}>＋ Новый набор…</option>
          </select>

          {assetTarget === NEW_PACK && (
            <div className="sa-emoji-new-pack">
              <input
                type="text" placeholder="Название (Fluent, Twemoji…)" value={newName}
                onChange={(e) => {
                  const wasAuto = !newKey || newKey === slugFromName(newName);
                  setNewName(e.target.value);
                  if (wasAuto) setNewKey(slugFromName(e.target.value));
                }}
              />
              <input type="text" placeholder="код: fluent" value={newKey}
                onChange={(e) => setNewKey(e.target.value)} />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'base' | 'animation')}>
                <option value="base">Оформление</option>
                <option value="animation">Анимация</option>
              </select>
            </div>
          )}

          <label className="sa-btn-ghost">
            <input
              type="file" accept=".zip,application/zip" style={{ display: 'none' }} disabled={!!busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importArchive(f); }}
            />
            {busy === 'import' ? 'Импортируем…' : 'Выбрать ZIP'}
          </label>

          <label className="sa-btn-ghost" title="emoji-test.txt или свой JSON: категории, порядок, названия">
            <input
              type="file" accept=".txt,.json" style={{ display: 'none' }} disabled={!!busy}
              onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                const form = new FormData();
                form.append('structure', f);
                run('structure', () => superAdminApi.post('/emoji/admin/structure', form));
              }}
            />
            Загрузить структуру
          </label>
        </div>

        {system && (
          <p className="sa-hint">
            В каталоге {system.logicalItems} смайликов, структура задаёт
            {' '}{system.structure.item_count} в {system.structure.group_count} разделах.
          </p>
        )}
      </section>

      {/* ===== ЧТО показывать ===== */}
      <section className="sa-emoji-catalog">
        <div className="sa-catalog-tools">
          <input
            type="search"
            className="sa-catalog-search"
            placeholder="Поиск: название, ключевое слово, код или сам смайлик"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="sa-catalog-filters">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                title={f.hint}
                className={'sa-catalog-filter' + (filter === f.key ? ' is-active' : '')}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {!!selected.size && (
          <div className="sa-catalog-bulk">
            <span>Выбрано: {selected.size}</span>
            <button type="button" onClick={() => bulk(false)} disabled={!!busy}>Выключить</button>
            <button type="button" onClick={() => bulk(true)} disabled={!!busy}>Включить</button>
            <button type="button" className="sa-btn-ghost" onClick={() => setSelected(new Set())}>Снять выбор</button>
          </div>
        )}

        {!searching && (
          <div className="sa-catalog-cats">
            {packs.map((pack) => {
              const total = pack.items?.length || 0;
              const off = (pack.items || []).filter((i) => i.retired).length;
              return (
                <button
                  key={pack.id}
                  type="button"
                  className={'sa-catalog-cat' + (openPack === pack.id ? ' is-open' : '') + (pack.enabled ? '' : ' is-off')}
                  onClick={() => setOpenPack(openPack === pack.id ? null : pack.id)}
                >
                  <span>{pack.name}</span>
                  <small>{total}{off ? ` · выкл. ${off}` : ''}</small>
                </button>
              );
            })}
          </div>
        )}

        {searching && (
          <p className="sa-hint">
            Найдено {found.length}{found.length === 400 ? ' (показаны первые 400)' : ''}.
          </p>
        )}

        <div className="sa-catalog-rows">
          {rows.map(({ item, pack }) => {
            const base = (item.assets || []).filter((a) => a.role === 'base');
            const anim = (item.assets || []).filter((a) => a.role === 'animation');
            const versions = [...anim, ...base];
            const openTones = expanded?.id === item.id && expanded.kind === 'tones';
            const openAssets = expanded?.id === item.id && expanded.kind === 'assets';

            return (
              <div key={item.id} className={'sa-row' + (item.retired ? ' is-off' : '')}>
                <input
                  type="checkbox"
                  className="sa-row-pick"
                  checked={selected.has(item.id)}
                  onChange={() => pick(item.id)}
                  aria-label="Выбрать смайлик"
                />

                {/* Плацдарм: картинка активного базового набора */}
                <div className="sa-cell sa-cell-base" title={item.file_path ? 'Основное оформление' : 'Нет картинки ни в одном базовом наборе'}>
                  {item.file_path
                    ? <img src={resolveUploadUrl(item.file_path) || ''} alt={item.name} />
                    : <span className="sa-cell-empty">—</span>}
                </div>

                {/* Сам символ и его код */}
                <div className="sa-cell sa-cell-unicode">
                  <span className="sa-glyph">{item.unicode || item.fallback || item.emoji}</span>
                  <code>{codeOf(item.unicode_key) || item.name}</code>
                  {item.label && <small>{item.label}</small>}
                </div>

                {/* Цветовые вариации */}
                <div className="sa-cell sa-cell-tones">
                  {item.tones?.length ? (
                    <button
                      type="button"
                      className={'sa-chip' + (openTones ? ' is-open' : '')}
                      onClick={() => setExpanded(openTones ? null : { id: item.id, kind: 'tones' })}
                    >
                      🎨 {item.tones.length}
                    </button>
                  ) : <span className="sa-cell-empty">—</span>}
                </div>

                {/* Версии из наборов */}
                <div className="sa-cell sa-cell-versions">
                  {versions.length ? (
                    <button
                      type="button"
                      className={'sa-chip' + (openAssets ? ' is-open' : '')}
                      onClick={() => setExpanded(openAssets ? null : { id: item.id, kind: 'assets' })}
                    >
                      {versions.filter((a) => a.enabled).length}/{versions.length} наборов
                    </button>
                  ) : <span className="sa-cell-empty">нет</span>}
                </div>

                {/* Хвост строки */}
                <label className="switch sa-row-enabled" title={item.retired ? 'Выключен: не вставить из панели' : 'Включён'}>
                  <input
                    type="checkbox"
                    checked={!item.retired}
                    disabled={busy === `item-${item.id}`}
                    onChange={() => toggleItem(item)}
                  />
                  <span className="switch-track"><span className="switch-thumb" /></span>
                </label>

                <button
                  type="button"
                  className="sa-row-delete"
                  title="Удалить смайлик из каталога"
                  disabled={!!busy}
                  onClick={() => removeItem(item)}
                >
                  ✕
                </button>

                {openTones && (
                  <div className="sa-row-drawer">
                    <span className="sa-drawer-title">Цветовые вариации — следуют за основным смайликом</span>
                    <div className="sa-drawer-items">
                      {item.tones!.map((tone) => (
                        <span key={tone.unicode_key} className="sa-tone" title={codeOf(tone.unicode_key)}>
                          <img src={resolveUploadUrl(tone.file_path) || ''} alt={tone.unicode} />
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {openAssets && (
                  <div className="sa-row-drawer">
                    <span className="sa-drawer-title">
                      Версии смайлика. Выключенная пропускается, и берётся следующий набор по порядку.
                    </span>
                    <div className="sa-drawer-items">
                      {versions.map((asset) => (
                        <label
                          key={asset.pack_id}
                          className={'sa-version' + (asset.enabled ? '' : ' is-off') + (asset.pack_enabled ? '' : ' is-pack-off')}
                          title={asset.pack_enabled
                            ? `${asset.pack_name} — ${ROLE_LABEL[asset.role]}`
                            : `${asset.pack_name} — весь набор выключен`}
                        >
                          <img src={resolveUploadUrl(asset.file_path) || ''} alt={asset.pack_name} />
                          <span className="sa-version-name">{asset.pack_name}</span>
                          <input
                            type="checkbox"
                            checked={asset.enabled}
                            disabled={busy === `asset-${item.id}-${asset.pack_id}`}
                            onChange={() => toggleAsset(item, asset)}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!!more && (
            <button type="button" className="sa-btn-ghost sa-catalog-more" onClick={() => setShown((n) => n + PAGE)}>
              Показать ещё {Math.min(more, PAGE)} из {more}
            </button>
          )}

          {!rows.length && (
            <p className="sa-hint">
              {searching ? 'Ничего не найдено.' : 'Выберите раздел выше.'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

export default EmojiCatalogPanel;
