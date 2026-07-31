import React, { useMemo, useRef, useState } from 'react';
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
import { CalendarOccurrence, CalendarScope, CalendarViewMode, EventDraft, SeriesScope } from './types';
import './calendar.css';

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
}

const VIEW_LABELS: { value: CalendarViewMode; label: string }[] = [
  { value: 'month', label: 'Месяц' },
  { value: 'week', label: 'Неделя' },
  { value: 'day', label: 'День' },
  { value: 'agenda', label: 'Расписание' },
];

interface DraftTarget {
  occurrence: CalendarOccurrence | null;
  start: number;
  allDay: boolean;
}

const CalendarWidget: React.FC<CalendarWidgetProps> = ({ scope, title = 'Календарь', onBack }) => {
  const {
    mode, setMode, anchor, setAnchor, occurrences,
    layers, isLayerEnabled, toggleLayer, canPublishGlobal,
    loading, error, reload,
  } = useCalendarData(scope);

  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [details, setDetails] = useState<CalendarOccurrence | null>(null);
  const [actionError, setActionError] = useState('');

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

  const heading = mode === 'week'
    ? weekTitle(anchor)
    : mode === 'day'
      ? formatDayLong(anchor)
      : mode === 'agenda'
        ? 'Ближайшие события'
        : monthTitle(anchor);

  // Куда сдвинута дата от режима к режиму. По этому же правилу считаются
  // подписи соседних периодов в подсказках сверху и снизу.
  const shiftedAnchor = (direction: number): DayKey => {
    if (mode === 'month') return addMonths(anchor, direction);
    if (mode === 'week') return addDays(anchor, direction * 7);
    if (mode === 'day') return addDays(anchor, direction);
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
    if (mode === 'month') return monthShortTitle(target);
    if (mode === 'week') return weekTitle(target);
    return formatDayLong(target);
  };

  // «Расписание» не листается: там длинный список, и прокручивать его — это
  // прокрутка, а не переход. Отсюда же скрыты подсказки и анимация.
  const pageable = mode !== 'agenda';

  // Колесо и свайп листают то же, что стрелки в шапке. В сетке времени
  // переход случается, только когда сутки долистаны до края.
  useStepGestures(mainRef, shift, {
    enabled: pageable && !draft && !details,
    scrollable: () => (mode === 'week' || mode === 'day' ? gridScrollRef.current : null),
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
          {VIEW_LABELS.map((view) => (
            <button
              key={view.value}
              type="button"
              className={`cal-view${mode === view.value ? ' is-active' : ''}`}
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

      <div className="cal-body">
        <aside className="cal-side">
          <MiniMonth
            selected={anchor}
            onSelect={(day) => { setAnchor(day); if (mode === 'agenda') setMode('day'); }}
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

          {/* key на обёртке: смена даты пересоздаёт узел, и анимация въезда
              запускается заново. Без этого CSS-анимация отработала бы один раз
              за всю жизнь компонента. В месяце ключом идёт сам месяц, а не
              день: выбор даты в маленьком календаре (например, в мини-окошке
              внутри того же месяца) не должен пересоздавать всю сетку и
              переигрывать анимацию въезда — меняется только подсветка
              выбранного дня. */}
          <div
            key={`${mode}:${mode === 'month' ? monthKeyOf(anchor) : anchor}`}
            className={`cal-page${pageable ? (direction >= 0 ? ' is-next' : ' is-prev') : ''}`}
          >
            {mode === 'month' && (
              <MonthView
                anchor={anchor}
                selected={anchor}
                occurrences={occurrences}
                onOpenDay={(day) => { setAnchor(day); setMode('day'); }}
                onCreate={(day) => { setAnchor(day); openCreate(day, null); }}
                onOpenEvent={openOccurrence}
              />
            )}

            {(mode === 'week' || mode === 'day') && (
              <TimeGridView
                anchor={anchor}
                days={mode === 'week' ? weekDays(anchor) : [anchor]}
                occurrences={occurrences}
                onCreateAt={(day, minutes) => openCreate(day, minutes)}
                onOpenEvent={openOccurrence}
                scrollRef={gridScrollRef}
              />
            )}

            {mode === 'agenda' && (
              <AgendaView
                occurrences={occurrences}
                onOpenEvent={openOccurrence}
                onToggleTask={toggleTask}
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
