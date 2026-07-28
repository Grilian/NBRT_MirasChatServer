import React from 'react';
import {
  DayKey, WEEKDAY_LABELS, addDays, dayKeyOf, formatClock, formatDayLong,
  todayKey, weekdayIndex,
} from './dates';
import { sortForDay } from './layout';
import { CalendarOccurrence } from './types';

interface AgendaViewProps {
  occurrences: CalendarOccurrence[];
  onOpenEvent: (occurrence: CalendarOccurrence) => void;
  onToggleTask: (occurrence: CalendarOccurrence) => void;
}

// Расписание показывает только дни, в которых что-то есть: сплошная лента
// пустых дат — это не список дел, а календарь, набранный столбиком.
const AgendaView: React.FC<AgendaViewProps> = ({ occurrences, onOpenEvent, onToggleTask }) => {
  const today = todayKey();
  const tomorrow = addDays(today, 1);

  const byDay = new Map<DayKey, CalendarOccurrence[]>();
  for (const occurrence of occurrences) {
    const day = dayKeyOf(occurrence.starts_at);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(occurrence);
    else byDay.set(day, [occurrence]);
  }

  // Array.from, а не spread: цель сборки — ES5, там итератор Map не
  // разворачивается (см. tsconfig).
  const days = Array.from(byDay.keys()).sort();

  if (days.length === 0) {
    return (
      <div className="cal-empty">
        <p>На ближайшие три месяца ничего не запланировано.</p>
      </div>
    );
  }

  const dayCaption = (day: DayKey) => {
    if (day === today) return 'Сегодня';
    if (day === tomorrow) return 'Завтра';
    return `${formatDayLong(day)}, ${WEEKDAY_LABELS[weekdayIndex(day)]}`;
  };

  return (
    <div className="cal-agenda">
      {days.map((day) => (
        <section key={day} className={`cal-agenda-day${day === today ? ' is-today' : ''}`}>
          <h3 className="cal-agenda-caption">{dayCaption(day)}</h3>

          <div className="cal-agenda-items">
            {sortForDay(byDay.get(day)!).map((item) => (
              <div key={item.id} className={`cal-agenda-row${item.completed ? ' is-done' : ''}`}>
                {item.is_task && item.event_id !== null ? (
                  <button
                    type="button"
                    className={`cal-check${item.completed ? ' is-checked' : ''}`}
                    onClick={() => onToggleTask(item)}
                    aria-label={item.completed ? 'Отменить выполнение' : 'Отметить выполненной'}
                  >
                    {item.completed && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ) : (
                  <span className={`cal-dot cal-color-${item.color}`} aria-hidden="true" />
                )}

                <span className="cal-agenda-time">
                  {item.all_day ? 'весь день' : formatClock(item.starts_at)}
                </span>

                <button type="button" className="cal-agenda-title" onClick={() => onOpenEvent(item)}>
                  {item.title}
                  {item.location && <span className="cal-agenda-place">{item.location}</span>}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

export default AgendaView;
