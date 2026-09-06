import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import { resolveUploadUrl } from '../utils/uploads';
import { CustomEmoji, DEFAULT_EMOJI_FALLBACK } from '../utils/customEmoji';
import { PickedCustomEmoji } from './EmojiComposerField';
import { dismissLayerWithoutUnderlayActivation } from '../utils/dismissLayer';
import EmojiVariantPopup from './EmojiVariantPopup';

// Столько же, сколько удержание в переписке и в сетке смайликов админки:
// жест один и тот же, и разное время в разных местах читалось бы как сбой.
const TONE_LONG_PRESS_MS = 260;

// Android шлёт touchmove от дрожания неподвижного пальца, поэтому отменять
// удержание по ЛЮБОМУ движению нельзя — иначе оно не срабатывает вовсе. Тот
// же порог, что у удержания в списке чатов.
const TONE_MOVE_TOLERANCE_PX = 10;

export interface EmojiPack {
  id: number;
  name: string;
  emoji: string[];
  /** Кастомные смайлики-картинки; в текст уходит их :name:. */
  custom?: CustomEmoji[];
}

interface EmojiPickerProps {
  /**
   * Юникодный смайлик отдаётся строкой, картиночный — объектом: поле ввода
   * показывает его картинкой и строит узел прямо из этих данных, а искать их
   * заново по имени незачем — здесь они уже под рукой.
   */
  onPick: (emoji: string | PickedCustomEmoji) => void;
  onClose: () => void;
  /** На телефоне панель является нижней частью composer, а не popup поверх чата. */
  mobilePanel?: boolean;
  mobileHeight?: number;
  /**
   * Внутри общего пикера «Эмодзи / Стикеры / GIF» корневой контейнер, закрытие
   * по клику мимо и высоту мобильной панели держит родитель (ContentPicker) —
   * здесь остаётся только само содержимое вкладки. Иначе получилось бы два
   * вложенных контейнера с двумя независимыми обработчиками закрытия.
   */
  embedded?: boolean;
  /**
   * Готовые данные вместо запроса API. Нужны тестам компонента, чтобы проверять
   * выбор смайлика детерминированно и не подменять общий HTTP-клиент.
   */
  packsOverride?: EmojiPack[];
  /** Имена уже выбранных кастомных смайликов — для визуальной отметки. */
  selectedCustomEmoji?: string[];
}

// Кэш только чтобы не мигать пустой панелью на каждое открытие (компонент
// размонтируется при закрытии — см. MessageInput, `{emojiOpen && <EmojiPicker
// .../>}`). Раньше на нём стояла ранняя остановка «если кэш уже есть —
// не перезапрашивать вовсе», и пак, добавленный супер-админом уже ПОСЛЕ
// первого открытия панели у конкретного человека, не появлялся до
// перезапуска приложения — тот же баг, что чинили для отрисовки кастомных
// смайликов в сообщениях (Chat.tsx, обновление на реконнекте), просто в
// другом месте. Показываем старые данные мгновенно, а свежие подтягиваем
// на каждое открытие панели — запрос лёгкий, лишним не будет.
let cachedPacks: EmojiPack[] | null = null;

/**
 * Сбросить кэш — по событию `emoji_changed` от сервера. Без этого панель после
 * правки состава в панели управления показала бы старые данные до тех пор, пока
 * её не откроют дважды: первое открытие отдаёт кэш и только запускает запрос.
 */
export const invalidateEmojiPackCache = () => { cachedPacks = null; };

const EmojiPicker: React.FC<EmojiPickerProps> = ({
  onPick, onClose, mobilePanel = false, mobileHeight, embedded = false,
  packsOverride, selectedCustomEmoji = [],
}) => {
  const [packs, setPacks] = useState<EmojiPack[]>(packsOverride || cachedPacks || []);
  const [activePack, setActivePack] = useState(0);
  const [search, setSearch] = useState('');
  // Выбор тона кожи: сервер схлопнул вариации под базовую карточку, и добраться
  // до них можно удержанием (телефон) или правым кликом (ПК). Ничего не
  // выбирать — нормальный исход: обычный тап по-прежнему вставляет базовый.
  const [tonePopup, setTonePopup] = useState<{ item: CustomEmoji; anchorRect: DOMRect } | null>(null);
  const toneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Состояние ОДНОГО касания целиком, а не отдельный флаг «сработало».
  // Отдельный флаг был общим на все ячейки и сбрасывался только у тех, что с
  // тонами: после первого же удержания он залипал в true и preventDefault на
  // touchend навсегда глушил клик по ВСЕМ остальным смайликам. Объект живёт
  // ровно от touchstart до touchend, поэтому залипать нечему.
  const toneGestureRef = useRef<{ id: number; x: number; y: number; fired: boolean; moved: boolean } | null>(null);

  const openTones = (item: CustomEmoji, target: HTMLElement) => {
    if (!item.tones?.length) return;
    setTonePopup({ item, anchorRect: target.getBoundingClientRect() });
  };

  const cancelToneTimer = () => {
    if (toneTimerRef.current) clearTimeout(toneTimerRef.current);
    toneTimerRef.current = null;
  };

  useEffect(() => cancelToneTimer, []);
  const [loading, setLoading] = useState(!packsOverride && !cachedPacks);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (packsOverride) {
      setPacks(packsOverride);
      setActivePack((currentIndex) => Math.min(currentIndex, Math.max(0, packsOverride.length - 1)));
      setLoading(false);
      return;
    }
    api.get('/emoji')
      .then(({ data }) => { cachedPacks = data; setPacks(data); })
      .catch(() => { if (!cachedPacks) setPacks([]); })
      .finally(() => setLoading(false));
  }, [packsOverride]);

  // Закрытие по клику мимо и по Escape. Клик по самой кнопке-смайлику в
  // composer'е сюда не долетает — она останавливает всплытие и переключает
  // панель сама, иначе панель закрывалась бы и открывалась одним нажатием.
  useEffect(() => {
    // На мобильном это не всплывашка, а постоянная нижняя панель вместо
    // клавиатуры. Закрывать её по любому touchstart снаружи нельзя: сама
    // кнопка-переключатель находится снаружи панели и иначе сначала закрывает,
    // а затем тут же снова открывает её синтетическим mouse-событием Android.
    if (mobilePanel || embedded) return;

    const onDocPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        dismissLayerWithoutUnderlayActivation(event, onClose);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, mobilePanel, embedded]);

  const current = packs[activePack];
  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru');
    if (!query) return null;
    return packs.flatMap((pack) => pack.custom || []).filter((item) => {
      const haystack = `${item.label || ''} ${item.keywords || ''} ${item.unicode_key || ''} ${item.fallback || ''}`
        .toLocaleLowerCase('ru');
      return haystack.includes(query);
    });
  }, [packs, search]);
  const visibleCustom = searchResults ?? current?.custom ?? [];
  // Текстовый резерв показываем не как «всё или ничего» при наличии картинок в
  // паке, а поштучно: скрываем только те символы, что дублируют уже показанную
  // картинку (тот же смайлик дважды — так собирает пикер реакций/статуса,
  // видевший системную копию рядом с загруженным оформлением). Юникодные
  // элементы новой каталожной системы, для которых картинка попросту ещё не
  // синхронизирована ни с одним набором оформления, под этот фильтр не
  // попадают — их символ ничего не дублирует и обязан остаться видимым:
  // раньше при наличии в паке хотя бы одной картинки эти элементы пропадали
  // полностью, ни картинкой, ни текстом.
  const customFallbacks = useMemo(
    () => new Set((current?.custom || []).map((item) => item.unicode || item.fallback).filter(Boolean)),
    [current],
  );
  const visibleEmoji = (current?.emoji || []).filter((glyph) => !customFallbacks.has(glyph));

  const body = (
    <>
      {packs.length > 1 && (
        <div className="emoji-tabs">
          {packs.map((pack, index) => (
            <button
              key={pack.id}
              type="button"
              className={'emoji-tab' + (index === activePack ? ' is-active' : '')}
              onClick={() => setActivePack(index)}
              title={pack.name}
              aria-label={pack.name}
            >
              {/* Только значок: названия паков занимали всю ширину шапки, а на
                  телефоне вкладки от них не помещались. Название осталось в
                  подсказке и в aria-label — для мыши и для читалки. */}
              <span className="emoji-tab-icon">
                {pack.custom?.[0]
                  ? <img className="custom-emoji" src={resolveUploadUrl(pack.custom[0].file_path) || ''} alt="" />
                  : (pack.emoji[0] || '🙂')}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="emoji-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
        </svg>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Поиск эмодзи…"
          aria-label="Поиск эмодзи"
        />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск">×</button>}
      </div>

      <div className="emoji-grid">
        {loading && <div className="emoji-empty">Загрузка…</div>}
        {!loading && (searchResults ? searchResults.length === 0 : (!current || (visibleEmoji.length === 0 && !current.custom?.length))) && (
          <div className="emoji-empty">{search ? 'Ничего не найдено' : 'Смайлики пока не добавлены'}</div>
        )}
        {/* Кастомные идут первыми: их добавляли осознанно под этот коллектив,
            а юникодных всегда много и они одинаковы везде. */}
        {visibleCustom.map((item) => {
          const selectionToken = item.unicode_key
            ? (item.unicode || item.fallback || DEFAULT_EMOJI_FALLBACK)
            : `:${item.name}:`;
          return (
          <button
            key={`c${item.id}`}
            type="button"
            className={'emoji-cell'
              + (selectedCustomEmoji.includes(selectionToken) ? ' is-selected' : '')
              + (item.tones?.length ? ' has-tones' : '')}
            aria-pressed={selectedCustomEmoji.includes(selectionToken)}
            title={item.tones?.length ? `:${item.name}: — удержание для выбора тона` : `:${item.name}:`}
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => {
              // Гасим всегда: на Android это системное меню выделения, которое
              // лезет поверх нашего выбора тона. А открываем только когда
              // касания нет вовсе — то есть по правому клику мышью. Во время
              // касания за открытие отвечает таймер удержания, и делать это
              // дважды значит открыть попап и тут же закрыть его.
              e.preventDefault();
              if (toneGestureRef.current) return;
              if (!item.tones?.length) return;
              openTones(item, e.currentTarget);
            }}
            onTouchStart={(e) => {
              const point = e.touches[0];
              // Жест заводится на ЛЮБОЙ ячейке, даже без тонов: именно он
              // решает на touchend, гасить ли клик, и стоит его не завести —
              // решение будет принято по чужому, давно отработавшему касанию.
              toneGestureRef.current = {
                id: item.id, x: point?.clientX ?? 0, y: point?.clientY ?? 0, fired: false, moved: false,
              };
              cancelToneTimer();
              if (!item.tones?.length) return;
              const target = e.currentTarget;
              toneTimerRef.current = setTimeout(() => {
                const gesture = toneGestureRef.current;
                if (!gesture || gesture.id !== item.id || gesture.moved) return;
                gesture.fired = true;
                openTones(item, target);
              }, TONE_LONG_PRESS_MS);
            }}
            onTouchMove={(e) => {
              const gesture = toneGestureRef.current;
              if (!gesture) return;
              const point = e.touches[0];
              if (!point) return;
              // Порог, а не любое движение: Android шлёт touchmove от дрожания
              // неподвижного пальца, и без порога удержание не срабатывает.
              if (Math.abs(point.clientX - gesture.x) <= TONE_MOVE_TOLERANCE_PX
                && Math.abs(point.clientY - gesture.y) <= TONE_MOVE_TOLERANCE_PX) return;
              gesture.moved = true;
              cancelToneTimer();
            }}
            onTouchEnd={(e) => {
              cancelToneTimer();
              const gesture = toneGestureRef.current;
              toneGestureRef.current = null;
              // Гасим синтетический click ТОЛЬКО если удержание сработало на
              // этой же ячейке: иначе он вставил бы базовый смайлик поверх
              // только что открытого выбора.
              if (gesture?.fired && gesture.id === item.id) e.preventDefault();
            }}
            onTouchCancel={() => { cancelToneTimer(); toneGestureRef.current = null; }}
            // В сообщение всё равно уходит код, а не картинка — формат хранения
            // переписки не меняется. Картинка нужна только полю ввода, чтобы
            // показать человеку смайлик вместо технического :name:.
            onClick={() => onPick({
              name: item.name,
              filePath: item.file_path,
              fallback: item.fallback || DEFAULT_EMOJI_FALLBACK,
              // Официальные наборы хранят в сообщении сам символ. Произвольные
              // пользовательские смайлики без unicode_key сохраняют :name:.
              token: item.unicode_key ? (item.unicode || item.fallback || DEFAULT_EMOJI_FALLBACK) : undefined,
              unicodeKey: item.unicode_key,
              variants: item.variants,
            })}
          >
            <img className="custom-emoji" src={resolveUploadUrl(item.file_path) || ''} alt={`:${item.name}:`} />
          </button>
          );
        })}
        {tonePopup && (
          <EmojiVariantPopup
            options={(tonePopup.item.tones || []).map((tone) => ({
              key: tone.unicode_key,
              label: tone.unicode || tone.fallback,
              filePath: tone.file_path,
            }))}
            currentFilePath={tonePopup.item.file_path}
            anchorRect={tonePopup.anchorRect}
            ariaLabel="Выбор тона кожи"
            onDismiss={() => setTonePopup(null)}
            onPick={(unicodeKey) => {
              const tone = tonePopup.item.tones?.find((t) => t.unicode_key === unicodeKey);
              setTonePopup(null);
              if (!tone) return;
              // В сообщение уходит сам тоновый символ, как и у базового: тон —
              // это отдельный Unicode-смайлик, а не оформление, и ссылаться на
              // строку каталога тут незачем.
              onPick({
                name: tonePopup.item.name,
                filePath: tone.file_path,
                fallback: tone.fallback || DEFAULT_EMOJI_FALLBACK,
                token: tone.unicode || tone.fallback || DEFAULT_EMOJI_FALLBACK,
                unicodeKey: tone.unicode_key,
              });
            }}
          />
        )}
        {/* Показываем и то, что осталось от текстового резерва после фильтра
            дублей выше (см. customFallbacks) — не как запасной вариант «на
            крайний случай», а как полноправную часть выдачи: у новой
            каталожной системы это ровно те элементы, для которых картинка
            ещё не загружена ни в один набор оформления. */}
        {!search && visibleEmoji.map((emoji, index) => (
          <button
            key={`${emoji}-${index}`}
            type="button"
            className="emoji-cell"
            // onMouseDown с preventDefault: иначе фокус уходит из поля ввода,
            // на телефоне закрывается клавиатура, а на компьютере теряется
            // позиция курсора — и смайлик вставляется не туда, где стоял.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  );

  if (embedded) return body;

  return (
    <div
      className={'emoji-picker' + (mobilePanel ? ' is-mobile-panel' : '')}
      ref={rootRef}
      style={mobilePanel && mobileHeight ? { height: `${mobileHeight}px` } : undefined}
    >
      {body}
    </div>
  );
};

export default EmojiPicker;
