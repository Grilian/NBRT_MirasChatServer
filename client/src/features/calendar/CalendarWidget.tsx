import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DayKey, addDays, addMonths, dayKeyOf, formatClock, formatDayLong, monthKeyOf, monthShortTitle,
  monthTitle, nextHalfHour, instantOf, todayKey, weekTitle, weekDays,
} from './dates';
import {
  createEvent, deleteEvent, deleteOccurrence, respondToInvite,
  setTaskCompleted, updateEvent, updateOccurrence,
} from './api';
import { useCalendarData } from './useCalendarData';
import { useCalendarKeys, useStepGestures } from './gestures';
import AgendaView from './AgendaView';
import EventDialog from './EventDialog';
import MiniMonth from './MiniMonth';
import MonthView from './MonthView';
import TimeGridView from './TimeGridView';
import WeekStrip from './WeekStrip';
import { resolveNow } from './now';
import { useLayoutMode } from '@/shared/hooks/useLayoutMode';
import { getUiPrefs } from '@/features/settings/uiPrefs';
import { CalendarOccurrence, CalendarScope, CalendarViewMode, EventDraft, SeriesScope } from './types';
import './calendar.css';

export interface CalendarOpenTarget {
  occurrenceId: string;
  startAt: number;
}

interface CalendarWidgetProps {
  /**
   * Ограничить одной областью. Не задан — календарь показывает объединение
   * всех доступных слоёв, и это основной режим. Задаётся для врезок: список
   * событий в карточке пространства, где весь календарь ни к чему.
   */
  scope?: CalendarScope;
  /** Заголовок раздела; в карточке пространства шапка будет своя. */
  title?: string;
  onBack?: () => void;
  /** Растёт, когда события изменил кто-то извне — сигнал перечитать диапазон. */
  changeToken?: number;
  /** Переход с «Главной»: открыть Расписание и сразу карточку выбранного события. */
  openTarget?: CalendarOpenTarget | null;
  onOpenTargetHandled?: () => void;
}

const VIEW_LABELS: { value: CalendarViewMode; label: string }[] = [
  { value: 'month', label: 'Месяц' },
  { value: 'week', label: 'Неделя' },
  { value: 'day', label: 'День' },
  // «Лента», а не «Расписание»: «Расписанием» теперь называется блок на
  // «Главной», и два разных экрана под одним словом человек читает как одно и
  // то же место.
  { value: 'agenda', label: 'Лента' },
];

/**
 * Что показывать на телефоне.
 *
 * Месяц и день оттуда убраны намеренно. Месячная сетка на 360px даёт по 50px
 * на клетку: туда не помещается ни название, ни время — остаются цветные
 * полоски, то есть картинка, по которой всё равно надо тыкать наугад. Общую
 * картину месяца даёт разворот полосы недели («Показать весь месяц»), а
 * читать события всё равно приходится лентой. Отдельный «День» рядом с лентой
 * не нужен: лента и так начинается с выбранного дня.
 */
const MOBILE_VIEWS: CalendarViewMode[] = ['agenda', 'week'];

/** На телефоне лента идёт первой — это основной способ читать календарь там. */
const MOBILE_VIEW_ORDER = (a: CalendarViewMode, b: CalendarViewMode) =>
  MOBILE_VIEWS.indexOf(a) - MOBILE_VIEWS.indexOf(b);

interface DraftTarget {
  occurrence: CalendarOccurrence | null;
  start: number;
  allDay: boolean;
}

const CalendarWidget: React.FC<CalendarWidgetProps> = ({
  scope, title = 'Календарь', onBack, changeToken = 0, openTarget, onOpenTargetHandled,
}) => {
  const {
    mode, setMode, anchor, setAnchor, occurrences,
    layers, isLayerEnabled, toggleLayer, canPublishGlobal,
    loading, error, reload,
  } = useCalendarData(scope, changeToken);

  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [details, setDetails] = useState<CalendarOccurrence | null>(null);
  const [actionError, setActionError] = useState('');
  // Полоса недели: развёрнута ли она в месяц. Состояние живёт здесь, а не в
  // самой полосе, потому что от него зависит и высота ленты под ней.
  const [monthOpen, setMonthOpen] = useState(false);

  // Узкий экран — тот же расчёт, что у всего приложения: заводить здесь свой
  // медиазапрос значит получить ширину, на которой календарь уже мобильный, а
  // навигация вокруг него ещё нет.
  const layout = useLayoutMode({
    rosterWidth: getUiPrefs().rosterWidth,
    rosterCollapsedByUser: getUiPrefs().rosterCollapsed,
  });
  const narrow = layout.mode === 'mobile';

  // На телефоне месяц и день не показываются вовсе (см. MOBILE_VIEWS), но в
  // сохранённом состоянии они остаться могут — человек выбрал их на компьютере
  // и открыл приложение на телефоне. Подменяем лентой на лету, а сам выбор не
  // трогаем: вернётся за компьютер — увидит то, что оставил.
  const effectiveMode: CalendarViewMode = narrow && !MOBILE_VIEWS.includes(mode) ? 'agenda' : mode;
  const views = narrow
    ? VIEW_LABELS.filter((v) => MOBILE_VIEWS.includes(v.value))
      .sort((a, b) => MOBILE_VIEW_ORDER(a.value, b.value))
    : VIEW_LABELS;

  // Направление последнего перехода: содержимое въезжает с той стороны, куда
  // листнули, — иначе смена месяца выглядит как мигание, и непонятно, вперёд
  // ты ушёл или назад.
  const [direction, setDirection] = useState(1);

  const mainRef = useRef<HTMLElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  const markedDays = useMemo(() => {
    const days = new Set<DayKey>();
    for (const occurrence of occurrences) days.add(dayKeyOf(occurrence.starts_at));
    return days;
  }, [occurrences]);

  const heading = effectiveMode === 'week'
    ? weekTitle(anchor)
    : effectiveMode === 'day'
      ? formatDayLong(anchor)
      : effectiveMode === 'agenda'
        // На телефоне над лентой стоит полоса недели, и месяц с неё же и
        // листается — заголовку правильнее называть месяц, а не «ближайшие».
        ? (narrow ? monthTitle(anchor) : 'Ближайшие события')
        : monthTitle(anchor);

  // Что идёт прямо сейчас. Один расчёт на оба применения — полосу в шапке и
  // подпись на карточке в ленте (см. now.ts).
  const nowState = useMemo(() => resolveNow(occurrences, Date.now()), [occurrences]);

  // Куда сдвинута дата от режима к режиму. По этому же правилу считаются
  // подписи соседних периодов в подсказках сверху и снизу.
  const shiftedAnchor = (direction: number): DayKey => {
    if (effectiveMode === 'month') return addMonths(anchor, direction);
    if (effectiveMode === 'week') return addDays(anchor, direction * 7);
    if (effectiveMode === 'day') return addDays(anchor, direction);
    // В ленте с полосой недели стрелки двигают ровно то, что видно: неделю, а
    // развёрнутая полоса — месяц. Прежний шаг в 30 дней рядом с полосой читался
    // бы как поломка: нажал «вперёд», а подсвеченное число уехало неизвестно
    // куда. Без полосы (широкий экран) шаг остаётся прежним.
    if (narrow) return monthOpen ? addMonths(anchor, direction) : addDays(anchor, direction * 7);
    return addDays(anchor, direction * 30);
  };

  const shift = (direction: number) => {
    setDirection(direction);
    setAnchor(shiftedAnchor(direction));
  };

  // Что лежит по соседству — этим подписаны полосы-подсказки. Человеку не
  // приходится догадываться, что тут вообще можно листать, и заодно видно,
  // куда именно он попадёт.
  const neighbourLabel = (direction: number): string => {
    const target = shiftedAnchor(direction);
    if (effectiveMode === 'month') return monthShortTitle(target);
    if (effectiveMode === 'week') return weekTitle(target);
    return formatDayLong(target);
  };

  // «Расписание» не листается: там длинный список, и прокручивать его — это
  // прокрутка, а не переход. Отсюда же скрыты подсказки и анимация.
  const pageable = effectiveMode !== 'agenda';

  // Колесо и свайп листают то же, что стрелки в шапке. В сетке времени
  // переход случается, только когда сутки долистаны до края.
  useStepGestures(mainRef, shift, {
    enabled: pageable && !draft && !details,
    scrollable: () => (effectiveMode === 'week' || effectiveMode === 'day' ? gridScrollRef.current : null),
  });

  useCalendarKeys({
    onStep: shift,
    onToday: () => setAnchor(todayKey()),
    onView: setMode,
    enabled: !draft && !details,
  });

  const openCreate = (day: DayKey, minutes: number | null, allDay = false) => {
    setDraft({
      occurrence: null,
      start: instantOf(day, minutes ?? nextHalfHour(day)),
      allDay,
    });
  };

  // Чужое событие и день рождения открываются только на просмотр: править
  // можно то, чем владеешь, остальное — карточка с деталями и ответом.
  const openOccurrence = (occurrence: CalendarOccurrence) => {
    if (occurrence.can_edit && occurrence.event_id !== null) {
      setDraft({ occurrence, start: occurrence.starts_at, allDay: occurrence.all_day });
    } else {
      setDetails(occurrence);
    }
  };

  // С «Главной» событие открывается не просто в календаре, а в «Расписании»
  // с уже раскрытой карточкой. Сначала переключаем режим и якорную дату,
  // затем ждём, пока useCalendarData загрузит соответствующий диапазон.
  useEffect(() => {
    if (!openTarget) return;
    setMode('agenda');
    setAnchor(dayKeyOf(openTarget.startAt));
  }, [openTarget, setMode, setAnchor]);

  useEffect(() => {
    if (!openTarget || loading) return;
    const occurrence = occurrences.find((item) => item.id === openTarget.occurrenceId);
    if (!occurrence) return;
    openOccurrence(occurrence);
    onOpenTargetHandled?.();
    // openOccurrence — локальная операция над найденным вхождением; специально
    // не добавляем её как зависимость, чтобы не переоткрывать диалог на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget, loading, occurrences, onOpenTargetHandled]);

  const handleSave = async (value: EventDraft, editingId: number | null, seriesScope: SeriesScope) => {
    if (editingId === null) {
      await createEvent(value);
    } else if (seriesScope === 'occurrence' && draft?.occurrence) {
      // Правим одно вхождение: ключом идёт его место в серии, а не новое
      // время, иначе повторный перенос завёл бы второе исключение.
      await updateOccurrence(editingId, draft.occurrence.occurrence_start, value);
    } else {
      await updateEvent(editingId, value);
    }
    reload();
  };

  const handleDelete = async (eventId: number, seriesScope: SeriesScope) => {
    if (seriesScope === 'occurrence' && draft?.occurrence) {
      await deleteOccurrence(eventId, draft.occurrence.occurrence_start);
    } else {
      await deleteEvent(eventId);
    }
    reload();
  };

  // Действия ниже вызываются прямо из разметки, поэтому ошибку тут некому
  // поймать: без catch отказ сервера превращался бы в необработанный промис,
  // а человек видел бы, что нажатие просто ничего не сделало.
  const toggleTask = async (occurrence: CalendarOccurrence) => {
    if (occurrence.event_id === null || !occurrence.can_edit) return;
    try {
      await setTaskCompleted(occurrence.event_id, occurrence.occurrence_start, !occurrence.completed);
      reload();
    } catch {
      setActionError('Не удалось отметить задачу');
    }
  };

  const respond = async (occurrence: CalendarOccurrence, answer: 'accepted' | 'declined') => {
    if (occurrence.event_id === null || !occurrence.is_guest) return;
    try {
      await respondToInvite(occurrence.event_id, answer);
      setDetails(null);
      reload();
    } catch {
      setActionError('Не удалось отправить ответ');
    }
  };

  return (
    <div className="cal-root">
      <header className="cal-toolbar">
        {onBack && (
          <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Назад">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
          </button>
        )}

        <button
          type="button"
          className={`cal-today${anchor === todayKey() ? ' is-active' : ''}`}
          onClick={() => setAnchor(todayKey())}
        >
          Сегодня
        </button>

        <div className="cal-nav">
          <button type="button" className="icon-btn" onClick={() => shift(-1)} aria-label="Назад">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button type="button" className="icon-btn" onClick={() => shift(1)} aria-label="Вперёд">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>

        <h1 className="cal-heading">{heading}</h1>

        <div className="cal-views">
          {views.map((view) => (
            <button
              key={view.value}
              type="button"
              className={`cal-view${effectiveMode === view.value ? ' is-active' : ''}`}
              onClick={() => setMode(view.value)}
            >
              {view.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn-primary cal-create"
          onClick={() => openCreate(anchor, null)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
          <span>Создать</span>
        </button>
      </header>

      {error && <p className="form-error cal-error">Не удалось загрузить календарь</p>}
      {actionError && (
        <p className="form-error cal-error" onAnimationEnd={() => setActionError('')}>{actionError}</p>
      )}

      {/* Полоса «сейчас» — то, ради чего в календарь заглядывают посреди дня:
          не «что сегодня было», а «где я должен быть в эту минуту». Событий на
          весь день она не показывает (см. now.ts): выставка длиной в сутки
          висела бы здесь весь день, вытесняя встречу через десять минут.
          На телефоне её нет — там то же самое написано прямо на карточке в
          ленте, и вторая полоса сверху отняла бы у списка целую строку. */}
      {!narrow && (nowState.current || nowState.next) && (
        <button
          type="button"
          className={'cal-upnext' + (nowState.current ? ' is-running' : '')}
          onClick={() => openOccurrence(nowState.current || nowState.next!)}
        >
          <span className="cal-upnext-mark">
            {nowState.current ? 'Сейчас' : 'Далее'}
          </span>
          <span className="cal-upnext-time">
            {formatClock((nowState.current || nowState.next!).starts_at)}
          </span>
          <span className="cal-upnext-title">{(nowState.current || nowState.next!).title}</span>
          <span className="cal-upnext-till">
            до {formatClock((nowState.current || nowState.next!).ends_at)}
          </span>
        </button>
      )}

      <div className="cal-body">
        <aside className="cal-side">
          <MiniMonth
            selected={anchor}
            onSelect={(day) => { setAnchor(day); if (effectiveMode === 'agenda') setMode('day'); }}
            markedDays={markedDays}
          />

          {/* Слои строятся по тому, что реально пришло: пространств может быть
              сколько угодно, перечислить их заранее нельзя. Выключенные
              запоминаются, иначе с несколькими пространствами пришлось бы
              настраивать список при каждом открытии. */}
          <div className="cal-layers">
            <div className="cal-layers-title">Слои</div>
            {layers.map((layer) => (
              <label key={layer.id} className="cal-layer">
                <input
                  type="checkbox"
                  checked={isLayerEnabled(layer.id)}
                  onChange={() => toggleLayer(layer.id)}
                />
                <span className={`cal-dot cal-color-${layer.color}`} aria-hidden="true" />
                <span className="cal-layer-name">{layer.label}</span>
                {layer.count > 0 && <span className="cal-layer-count">{layer.count}</span>}
              </label>
            ))}
          </div>
        </aside>

        <main className={`cal-main${loading ? ' is-loading' : ''}`} ref={mainRef}>
          {/* Полоса-подсказка. Она же кнопка: на телефоне подсказывает, что
              экран листается, на компьютере — работает как навигация, потому
              что тянуться к стрелкам в шапке ради соседнего месяца незачем. */}
          {pageable && (
            <button type="button" className="cal-peek is-prev" onClick={() => shift(-1)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m18 15-6-6-6 6" /></svg>
              <span>{neighbourLabel(-1)}</span>
            </button>
          )}

          {/* Полоса недели — мобильный способ ходить по датам. На широком
              экране её место занимает мини-календарь слева, и вторая
              навигация по числам там была бы просто дублем. */}
          {narrow && effectiveMode === 'agenda' && (
            <WeekStrip
              anchor={anchor}
              onSelect={setAnchor}
              occurrences={occurrences}
              expanded={monthOpen}
              onToggleExpanded={() => setMonthOpen((open) => !open)}
            />
          )}

          {/* key на обёртке: смена даты пересоздаёт узел, и анимация въезда
              запускается заново. Без этого CSS-анимация отработала бы один раз
              за всю жизнь компонента. В месяце ключом идёт сам месяц, а не
              день: выбор даты в маленьком календаре (например, в мини-окошке
              внутри того же месяца) не должен пересоздавать всю сетку и
              переигрывать анимацию въезда — меняется только подсветка
              выбранного дня. */}
          <div
            key={`${effectiveMode}:${effectiveMode === 'month' ? monthKeyOf(anchor) : anchor}`}
            className={`cal-page${pageable ? (direction >= 0 ? ' is-next' : ' is-prev') : ''}`}
          >
            {effectiveMode === 'month' && (
              <MonthView
                anchor={anchor}
                selected={anchor}
                occurrences={occurrences}
                onOpenDay={(day) => { setAnchor(day); setMode('day'); }}
                onSelectDay={setAnchor}
                onCreate={(day) => openCreate(day, null)}
                onOpenEvent={openOccurrence}
              />
            )}

            {(effectiveMode === 'week' || effectiveMode === 'day') && (
              <TimeGridView
                anchor={anchor}
                days={effectiveMode === 'week' ? weekDays(anchor) : [anchor]}
                occurrences={occurrences}
                onCreateAt={(day, minutes) => openCreate(day, minutes)}
                onOpenEvent={openOccurrence}
                scrollRef={gridScrollRef}
              />
            )}

            {effectiveMode === 'agenda' && (
              <AgendaView
                occurrences={occurrences}
                onOpenEvent={openOccurrence}
                onToggleTask={toggleTask}
                /* На телефоне лента начинается с выбранного в полосе дня —
                   иначе выбор числа ничего бы не менял. На широком экране
                   лента остаётся сплошной: там рядом мини-календарь. */
                from={narrow ? anchor : undefined}
              />
            )}
          </div>

          {pageable && (
            <button type="button" className="cal-peek is-next" onClick={() => shift(1)}>
              <span>{neighbourLabel(1)}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          )}
        </main>
      </div>

      {draft && (
        <EventDialog
          scope={scope ?? { kind: 'personal' }}
          canPublishGlobal={canPublishGlobal}
          occurrence={draft.occurrence}
          initialStart={draft.start}
          initialAllDay={draft.allDay}
          onClose={() => setDraft(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}

      {details && (
        <div className="modal-overlay" onClick={() => setDetails(null)}>
          <div className="modal-card cal-details" onClick={(event) => event.stopPropagation()}>
            <div className="conv-head">
              <div className="cal-dialog-heading">
                {details.source === 'birthday' ? 'День рождения' : 'Событие'}
              </div>
              <button type="button" className="icon-btn" onClick={() => setDetails(null)} aria-label="Закрыть">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="cal-details-body">
              <div className={`cal-details-title cal-color-${details.color}`}>{details.title}</div>
              <div className="cal-details-when">
                {formatDayLong(dayKeyOf(details.starts_at))}
                {!details.all_day && ` · ${formatClock(details.starts_at)}–${formatClock(details.ends_at)}`}
              </div>

              {details.location && <div className="cal-details-row">{details.location}</div>}
              {details.description && <p className="cal-details-note">{details.description}</p>}

              {details.guests.length > 0 && (
                <div className="cal-details-row">
                  Участники: {details.guests.map((guest) => guest.display_name).join(', ')}
                </div>
              )}

              {/* Отвечать можно только на приглашение. У общего события, где
                  человек просто зритель, отвечать не на что — сервер такой
                  ответ и не принял бы. */}
              {details.source === 'calendar' && details.is_guest && (
                <div className="cal-details-actions">
                  <button type="button" className="btn-primary" onClick={() => respond(details, 'accepted')}>
                    Пойду
                  </button>
                  <button type="button" className="cal-dialog-delete" onClick={() => respond(details, 'declined')}>
                    Не пойду
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CalendarWidget;
