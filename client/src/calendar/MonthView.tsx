import React from 'react';
import {
  DayKey, WEEKDAY_LABELS, dayNumber, formatClock, isSameMonth, isWeekend,
  monthGrid, startOfWeek, todayKey,
} from './dates';
import { occurrencesOn, sortForDay } from './layout';
import { CalendarOccurrence } from './types';

interface MonthViewProps {
  anchor: DayKey;
  occurrences: CalendarOccurrence[];
  onOpenDay: (day: DayKey) => void;
  onCreate: (day: DayKey) => void;
  onOpenEvent: (occurrence: CalendarOccurrence) => void;
}

// Сколько вхождений помещается в клетку до «ещё N». Больше трёх в клетку
// месяца не влезает без превращения сетки в нечитаемую кашу — остальные
// открываются переходом в день.
const VISIBLE_PER_DAY = 3;

const MonthView: React.FC<MonthViewProps> = ({
  anchor, occurrences, onOpenDay, onCreate, onOpenEvent,
}) => {
  const weeks = monthGrid(anchor);
  const today = todayKey();
  const currentWeekStart = startOfWeek(today);

  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {WEEKDAY_LABELS.map((label, index) => (
          <div key={label} className={`cal-month-weekday${index >= 5 ? ' is-weekend' : ''}`}>
            {label}
          </div>
        ))}
      </div>

      <div className="cal-month-grid">
        {weeks.map((week) => (
          // Текущая неделя подсвечивается целой строкой: так видно, где ты
          // находишься, даже когда сегодняшний день ушёл за край экрана.
          <div
            key={week[0]}
            className={`cal-month-row${week[0] === currentWeekStart ? ' is-current-week' : ''}`}
          >
            {week.map((day) => {
              const items = sortForDay(occurrencesOn(occurrences, day));
              const visible = items.slice(0, VISIBLE_PER_DAY);
              const hidden = items.length - visible.length;

              return (
                <div
                  key={day}
                  className={
                    'cal-month-cell'
                    + (isSameMonth(day, anchor) ? '' : ' is-outside')
                    + (isWeekend(day) ? ' is-weekend' : '')
                    + (day === today ? ' is-today' : '')
                  }
                  onDoubleClick={() => onCreate(day)}
                >
                  <button
                    type="button"
                    className="cal-month-daynum"
                    onClick={() => onOpenDay(day)}
                    title="Открыть день"
                  >
                    {dayNumber(day)}
                  </button>

                  <div className="cal-month-items">
                    {visible.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={
                          `cal-chip cal-color-${item.color}`
                          + (item.all_day ? ' is-allday' : '')
                          + (item.completed ? ' is-done' : '')
                        }
                        onClick={() => onOpenEvent(item)}
                      >
                        {!item.all_day && <span className="cal-chip-time">{formatClock(item.starts_at)}</span>}
                        <span className="cal-chip-title">{item.title}</span>
                      </button>
                    ))}

                    {hidden > 0 && (
                      <button type="button" className="cal-chip-more" onClick={() => onOpenDay(day)}>
                        ещё {hidden}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MonthView;
