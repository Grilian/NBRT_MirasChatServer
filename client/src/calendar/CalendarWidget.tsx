import React, { useMemo, useRef, useState } from 'react';
import {
  DayKey, addDays, addMonths, dayKeyOf, formatClock, formatDayLong, monthTitle,
  nextHalfHour, instantOf, todayKey, weekTitle, weekDays,
} from './dates';
import { createEvent, deleteEvent, respondToInvite, setTaskCompleted, updateEvent } from './api';
import { useCalendarData } from './useCalendarData';
import { useCalendarKeys, useStepGestures } from './gestures';
import AgendaView from './AgendaView';
import EventDialog from './EventDialog';
import MiniMonth from './MiniMonth';
import MonthView from './MonthView';
import TimeGridView from './TimeGridView';
import { CalendarOccurrence, CalendarScope, CalendarViewMode, EventDraft } from './types';
import './calendar.css';

interface CalendarWidgetProps {
  /**
   * Чей календарь показываем. Личный сегодня, календарь пространства — когда
   * появятся пространства; всё остальное в виджете от этого не зависит.
   */
  scope: CalendarScope;
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
    loading, error, showBirthdays, setShowBirthdays, reload,
  } = useCalendarData(scope);

  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [details, setDetails] = useState<CalendarOccurrence | null>(null);

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

  // Шаг стрелок зависит от режима: в месяце листается месяц, в неделе — неделя.
  const shift = (direction: number) => {
    if (mode === 'month') setAnchor(addMonths(anchor, direction));
    else if (mode === 'week') setAnchor(addDays(anchor, direction * 7));
    else if (mode === 'day') setAnchor(addDays(anchor, direction));
    else setAnchor(addDays(anchor, direction * 30));
  };

  // Колесо и свайп листают то же, что стрелки в шапке. В «Расписании» жест
  // выключен: там длинный список, и листать его — это прокрутка, а не переход.
  // В сетке времени переход случается, только когда сутки долистаны до края.
  useStepGestures(mainRef, shift, {
    enabled: mode !== 'agenda' && !draft && !details,
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
    if (occurrence.is_owner && occurrence.event_id !== null) {
      setDraft({ occurrence, start: occurrence.starts_at, allDay: occurrence.all_day });
    } else {
      setDetails(occurrence);
    }
  };

  const handleSave = async (value: EventDraft, editingId: number | null) => {
    if (editingId === null) await createEvent(value);
    else await updateEvent(editingId, value);
    reload();
  };

  const handleDelete = async (eventId: number) => {
    await deleteEvent(eventId);
    reload();
  };

  const toggleTask = async (occurrence: CalendarOccurrence) => {
    if (occurrence.event_id === null) return;
    await setTaskCompleted(occurrence.event_id, occurrence.occurrence_start, !occurrence.completed);
    reload();
  };

  const respond = async (occurrence: CalendarOccurrence, answer: 'accepted' | 'declined') => {
    if (occurrence.event_id === null) return;
    await respondToInvite(occurrence.event_id, answer);
    setDetails(null);
    reload();
  };

  return (
    <div className="cal-root">
      <header className="cal-toolbar">
        {onBack && (
          <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Назад">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
          </button>
        )}

        <button type="button" className="cal-today" onClick={() => setAnchor(todayKey())}>
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

      <div className="cal-body">
        <aside className="cal-side">
          <MiniMonth
            selected={anchor}
            onSelect={(day) => { setAnchor(day); if (mode === 'agenda') setMode('day'); }}
            markedDays={markedDays}
          />

          <div className="cal-layers">
            <div className="cal-layers-title">Слои</div>
            <label className="cal-layer">
              <input type="checkbox" checked readOnly disabled />
              <span className="cal-dot cal-color-blue" aria-hidden="true" />
              <span>Мои события</span>
            </label>
            <label className="cal-layer">
              <input
                type="checkbox"
                checked={showBirthdays}
                onChange={(event) => setShowBirthdays(event.target.checked)}
              />
              <span className="cal-dot cal-color-birthday" aria-hidden="true" />
              <span>Дни рождения</span>
            </label>
          </div>
        </aside>

        <main className={`cal-main${loading ? ' is-loading' : ''}`} ref={mainRef}>
          {mode === 'month' && (
            <MonthView
              anchor={anchor}
              occurrences={occurrences}
              onOpenDay={(day) => { setAnchor(day); setMode('day'); }}
              onCreate={(day) => openCreate(day, null)}
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
        </main>
      </div>

      {draft && (
        <EventDialog
          scope={scope}
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

              {details.source === 'calendar' && !details.is_owner && (
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
