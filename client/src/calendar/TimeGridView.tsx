import React, { useEffect, useRef } from 'react';
import {
  DayKey, WEEKDAY_LABELS, dayNumber, formatClock, formatMinutes, instantOf,
  isWeekend, minutesOf, todayKey, weekdayIndex, weekDays,
} from './dates';
import { nowFraction, occurrencesOn, positionDay } from './layout';
import { CalendarOccurrence } from './types';

interface TimeGridViewProps {
  anchor: DayKey;
  /** Неделя — семь колонок, день — одна. Сетка та же. */
  days: DayKey[];
  occurrences: CalendarOccurrence[];
  onCreateAt: (day: DayKey, minutes: number) => void;
  onOpenEvent: (occurrence: CalendarOccurrence) => void;
  /**
   * Ссылка на прокручиваемую область отдаётся наружу: по ней виджет понимает,
   * что сутки долистаны до края и жест пора отдать листанию недель.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// Высота часа в пикселях. Из неё считается вся геометрия колонки, чтобы
// позиции событий и подписи часов не разъезжались.
const HOUR_HEIGHT = 48;

// Ниже этой высоты блок не вмещает две строки (время + название) и переходит на
// одну. 34px — это padding (4) плюс две строки по 14.4 при line-height 1.25.
const TWO_LINE_MIN_PX = 34;

// Шаг создания события кликом по пустому месту. Полчаса — как в Google
// Calendar: минутная точность при клике всё равно недостижима.
const SLOT_MINUTES = 30;

const TimeGridView: React.FC<TimeGridViewProps> = ({
  anchor, days, occurrences, onCreateAt, onOpenEvent, scrollRef: externalScrollRef,
}) => {
  const localScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? localScrollRef;
  const today = todayKey();

  // Сутки целиком в экран не помещаются, а начало рабочего дня интереснее
  // ночи — открываемся на 8:00, но если сегодня уже позже, показываем текущий час.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const isToday = days.includes(today);
    const focusMinutes = isToday ? Math.max(minutesOf(Date.now()) - 90, 0) : 8 * 60;
    container.scrollTop = (focusMinutes / 60) * HOUR_HEIGHT;
    // scrollRef — объект от useRef что снаружи, что localScrollRef внутри —
    // стабилен между рендерами, так что добавление в зависимости не даёт
    // лишних срабатываний, а линтер перестаёт жаловаться по делу: без него
    // эффект мог бы читать протухший ref, если бы источник ref когда-нибудь
    // сменился на лету.
  }, [anchor, days, today, scrollRef]);

  const allDayByDay = days.map((day) => occurrencesOn(occurrences, day).filter((item) => item.all_day));
  const hasAllDay = allDayByDay.some((items) => items.length > 0);

  const handleColumnClick = (event: React.MouseEvent<HTMLDivElement>, day: DayKey) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientY - bounds.top;
    const minutes = Math.floor((offset / bounds.height) * 24 * 60 / SLOT_MINUTES) * SLOT_MINUTES;
    onCreateAt(day, Math.max(0, Math.min(minutes, 24 * 60 - SLOT_MINUTES)));
  };

  return (
    <div className="cal-grid">
      <div className="cal-grid-head">
        <div className="cal-grid-gutter" />
        {days.map((day) => (
          <div
            key={day}
            className={
              'cal-grid-daylabel'
              + (day === today ? ' is-today' : '')
              + (isWeekend(day) ? ' is-weekend' : '')
            }
          >
            <span className="cal-grid-weekday">{WEEKDAY_LABELS[weekdayIndex(day)]}</span>
            <span className="cal-grid-daynum">{dayNumber(day)}</span>
          </div>
        ))}
      </div>

      {hasAllDay && (
        <div className="cal-grid-allday">
          <div className="cal-grid-gutter cal-grid-allday-label">весь день</div>
          {days.map((day, index) => (
            <div key={day} className="cal-grid-allday-cell">
              {allDayByDay[index].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`cal-chip cal-color-${item.color} is-allday${item.completed ? ' is-done' : ''}`}
                  title={item.location ? `${item.title} · ${item.location}` : item.title}
                  onClick={() => onOpenEvent(item)}
                >
                  <span className="cal-chip-title">{item.title}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="cal-grid-scroll" ref={scrollRef}>
        <div className="cal-grid-body" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="cal-grid-gutter cal-grid-hours">
            {HOURS.map((hour) => (
              <div key={hour} className="cal-grid-hour" style={{ height: HOUR_HEIGHT }}>
                {hour > 0 && <span>{formatMinutes(hour * 60)}</span>}
              </div>
            ))}
          </div>

          {days.map((day) => {
            const positioned = positionDay(occurrencesOn(occurrences, day), day);
            const now = nowFraction(day);

            return (
              <div
                key={day}
                className={`cal-grid-column${isWeekend(day) ? ' is-weekend' : ''}`}
                onClick={(event) => handleColumnClick(event, day)}
              >
                {HOURS.map((hour) => (
                  <div key={hour} className="cal-grid-slot" style={{ height: HOUR_HEIGHT }} />
                ))}

                {positioned.map(({ occurrence, top, height, lane, lanes }) => (
                  <button
                    key={occurrence.id}
                    type="button"
                    className={`cal-event cal-color-${occurrence.color}`
                      + `${occurrence.completed ? ' is-done' : ''}`
                      // Времени и названию двумя строками нужно около 34px, а
                      // получасовому событию в сетке достаётся 24 — название
                      // обрезалось поперёк буквы. Короткие раскладываем в
                      // строку: лучше «11:15 Экскурсия…», чем половина буквы.
                      + `${height * 24 * HOUR_HEIGHT < TWO_LINE_MIN_PX ? ' is-compact' : ''}`}
                    style={{
                      top: `${top * 100}%`,
                      height: `${height * 100}%`,
                      left: `calc(${(lane / lanes) * 100}% + 2px)`,
                      width: `calc(${(1 / lanes) * 100}% - 4px)`,
                    }}
                    title={occurrence.location ? `${occurrence.title} · ${occurrence.location}` : occurrence.title}
                    onClick={(event) => { event.stopPropagation(); onOpenEvent(occurrence); }}
                  >
                    <span className="cal-event-time">{formatClock(occurrence.starts_at)}</span>
                    <span className="cal-event-title">{occurrence.title}</span>
                  </button>
                ))}

                {now !== null && (
                  <div className="cal-now" style={{ top: `${now * 100}%` }} aria-hidden="true">
                    <span className="cal-now-dot" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TimeGridView;

/** Неделя вокруг даты — вынесено сюда, чтобы виджет не знал про раскладку сетки. */
export function weekColumns(anchor: DayKey): DayKey[] {
  return weekDays(anchor);
}

/** Момент клика по сетке в миллисекундах. */
export function slotInstant(day: DayKey, minutes: number): number {
  return instantOf(day, minutes);
}
