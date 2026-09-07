import React from 'react';
import {
  DayKey, WEEKDAY_LABELS, addDays, dayKeyOf, formatClock, formatDayLong,
  todayKey, weekdayIndex,
} from './dates';
import { sortForDay } from './layout';
import { isRunning } from './now';
import { CalendarOccurrence } from './types';

interface AgendaViewProps {
  occurrences: CalendarOccurrence[];
  onOpenEvent: (occurrence: CalendarOccurrence) => void;
  onToggleTask: (occurrence: CalendarOccurrence) => void;
  /**
   * Показывать дни начиная с этого. Задаётся полосой недели на телефоне:
   * выбрал среду — лента начинается со среды, а не отматывается к загруженному
   * началу диапазона.
   */
  from?: DayKey;
}

/** «1 событие / 2 события / 5 событий». */
function eventsLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} событий`;
  if (mod10 === 1) return `${count} событие`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} события`;
  return `${count} событий`;
}

// Расписание показывает только дни, в которых что-то есть: сплошная лента
// пустых дат — это не список дел, а календарь, набранный столбиком.
const AgendaView: React.FC<AgendaViewProps> = ({ occurrences, onOpenEvent, onToggleTask, from }) => {
  const today = todayKey();
  const tomorrow = addDays(today, 1);
  // Считается один раз на отрисовку: вызывать Date.now() в цикле по сотне
  // вхождений значит получить разное «сейчас» у соседних карточек.
  const now = Date.now();

  const byDay = new Map<DayKey, CalendarOccurrence[]>();
  for (const occurrence of occurrences) {
    const day = dayKeyOf(occurrence.starts_at);
    if (from && day < from) continue;
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
        <p>
          {from && from > today
            ? 'С этого дня ничего не запланировано.'
            : 'На ближайшие три месяца ничего не запланировано.'}
        </p>
      </div>
    );
  }

  const dayCaption = (day: DayKey) => {
    if (day === today) return `Сегодня, ${formatDayLong(day)}`;
    if (day === tomorrow) return `Завтра, ${formatDayLong(day)}`;
    return `${formatDayLong(day)}, ${WEEKDAY_LABELS[weekdayIndex(day)]}`;
  };

  return (
    <div className="cal-agenda">
      {days.map((day) => (
        <section key={day} className={`cal-agenda-day${day === today ? ' is-today' : ''}`}>
          <div className="cal-agenda-head">
            <h3 className="cal-agenda-caption">{dayCaption(day)}</h3>
            {/* Число событий у заголовка дня: по ленте прокручивают, и «сколько
                сегодня всего» иначе приходится считать глазами. */}
            <span className="cal-agenda-count">{eventsLabel(byDay.get(day)!.length)}</span>
          </div>

          <div className="cal-agenda-items">
            {sortForDay(byDay.get(day)!).map((item) => {
              const running = isRunning(item, now);
              return (
                <div
                  key={item.id}
                  className={`cal-agenda-row${item.completed ? ' is-done' : ''}${running ? ' is-running' : ''}`}
                >
                  {/* Галочка — только у того, кто вправе менять задачу. Чужую
                      (например, из общего календаря) сервер отметить не даст, и
                      показывать кнопку, которая заведомо не сработает, нельзя. */}
                  {item.is_task && item.event_id !== null && item.can_edit ? (
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
                    {item.all_day ? (
                      'весь день'
                    ) : (
                      <>
                        {formatClock(item.starts_at)}
                        {/* Время окончания — вторая строка, а не «11:00–12:00» в
                            одну: на телефоне колонка времени узкая, и диапазон
                            в одну строку либо ужимает шрифт, либо отъедает
                            место у названия. */}
                        <span className="cal-agenda-till">до {formatClock(item.ends_at)}</span>
                      </>
                    )}
                  </span>

                  <button type="button" className="cal-agenda-title" onClick={() => onOpenEvent(item)}>
                    {/* «Идёт сейчас» — то, ради чего в расписание заглядывают
                        посреди дня: не «что сегодня было», а «где я должен
                        быть в эту минуту». */}
                    {running && <span className="cal-agenda-now">Идёт сейчас</span>}
                    <span className="cal-agenda-name">{item.title}</span>
                    {item.location && <span className="cal-agenda-place">{item.location}</span>}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
};

export default AgendaView;
