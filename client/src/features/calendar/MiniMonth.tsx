import React, { useState } from 'react';
import {
  DayKey, addMonths, dayNumber, isSameMonth, monthGrid, monthTitle,
  startOfWeek, todayKey,
} from './dates';

interface MiniMonthProps {
  /** Выбранная дата — подсвечивается и определяет открытый месяц при сбросе. */
  selected: DayKey;
  onSelect: (day: DayKey) => void;
  /** Дни, в которых что-то есть, — под ними ставится точка. */
  markedDays?: Set<DayKey>;
}

// Маленький месяц: и навигация в боковой панели, и самостоятельный виджет —
// его же предстоит вставлять в карточку пространства, где полная сетка не
// поместится. Поэтому он ничего не знает про загрузку данных: получает
// отмеченные дни списком и сообщает наверх только выбор.
const MiniMonth: React.FC<MiniMonthProps> = ({ selected, onSelect, markedDays }) => {
  const [visibleMonth, setVisibleMonth] = useState<DayKey>(selected);
  const today = todayKey();
  const currentWeekStart = startOfWeek(today);
  const weeks = monthGrid(visibleMonth);

  return (
    <div className="cal-mini">
      <div className="cal-mini-head">
        <button
          type="button"
          className="cal-mini-nav"
          onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
          aria-label="Предыдущий месяц"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <span className="cal-mini-title">{monthTitle(visibleMonth)}</span>
        <button
          type="button"
          className="cal-mini-nav"
          onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
          aria-label="Следующий месяц"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>

      <div className="cal-mini-weekdays">
        {['П', 'В', 'С', 'Ч', 'П', 'С', 'В'].map((label, index) => (
          <span key={`${label}${index}`}>{label}</span>
        ))}
      </div>

      {weeks.map((week) => (
        <div
          key={week[0]}
          className={`cal-mini-row${week[0] === currentWeekStart ? ' is-current-week' : ''}`}
        >
          {week.map((day) => (
            <button
              key={day}
              type="button"
              className={
                'cal-mini-day'
                + (isSameMonth(day, visibleMonth) ? '' : ' is-outside')
                + (day === today ? ' is-today' : '')
                + (day === selected ? ' is-selected' : '')
                + (markedDays?.has(day) ? ' is-marked' : '')
              }
              onClick={() => onSelect(day)}
            >
              {dayNumber(day)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};

export default MiniMonth;
