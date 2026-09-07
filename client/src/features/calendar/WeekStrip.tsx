import React from 'react';
import {
  DayKey, WEEKDAY_LABELS, dayKeyOf, dayNumber, isWeekend, monthGrid, todayKey, weekDays,
} from './dates';
import { CalendarOccurrence } from './types';

/**
 * Полоса недели над лентой — мобильный способ ходить по датам.
 *
 * Зачем она вообще. На телефоне месячная сетка нечитаема: семь колонок на
 * 360px дают по 50px на день, и в клетку не помещается ни название события,
 * ни даже время — остаётся точка, то есть календарь превращается в картинку,
 * по которой всё равно надо тыкать наугад. Полоса же показывает НЕДЕЛЮ во всю
 * ширину: день получает 45px, но под ним лента с настоящими названиями.
 *
 * Месяц при этом не отменяется, а разворачивается по требованию («Показать
 * весь месяц»): раз в месяц-два посмотреть общую картину нужно, но каждый день
 * человек живёт неделей.
 *
 * Точка под числом — «в этот день что-то есть». Числа с точкой и без должны
 * различаться до того, как человек ткнул: иначе выбор дня превращается в
 * перебор.
 */
interface WeekStripProps {
  /** Выбранный день — вокруг него строится неделя. */
  anchor: DayKey;
  onSelect: (day: DayKey) => void;
  /** Всё, что загружено; полоса сама выберет нужные дни. */
  occurrences: CalendarOccurrence[];
  expanded: boolean;
  onToggleExpanded: () => void;
}

const WeekStrip: React.FC<WeekStripProps> = ({
  anchor, onSelect, occurrences, expanded, onToggleExpanded,
}) => {
  const today = todayKey();

  // Дни, в которых хоть что-то есть. Set, а не поиск по массиву на каждую
  // клетку: в развёрнутом месяце клеток 42, а вхождений за три месяца — сотни.
  const busy = new Set<DayKey>();
  for (const item of occurrences) busy.add(dayKeyOf(item.starts_at));

  const rows = expanded ? monthGrid(anchor) : [weekDays(anchor)];

  return (
    <div className={'cal-strip' + (expanded ? ' is-expanded' : '')}>
      <div className="cal-strip-heads" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="cal-strip-head">{label}</span>
        ))}
      </div>

      {rows.map((week, index) => (
        <div className="cal-strip-week" key={week[0] || index}>
          {week.map((day) => {
            const selected = day === anchor;
            return (
              <button
                key={day}
                type="button"
                className={'cal-strip-day'
                  + (selected ? ' is-selected' : '')
                  + (day === today ? ' is-today' : '')
                  + (isWeekend(day) ? ' is-weekend' : '')}
                aria-current={selected ? 'date' : undefined}
                onClick={() => onSelect(day)}
              >
                <span className="cal-strip-num">{dayNumber(day)}</span>
                {/* aria-hidden: для читалки «есть события» — не свойство
                    кнопки-даты, а содержимое ленты под ней, и озвучивать точку
                    отдельно значит читать список дважды. */}
                <span className={'cal-strip-dot' + (busy.has(day) ? ' is-busy' : '')} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ))}

      <button type="button" className="cal-strip-toggle" onClick={onToggleExpanded}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
        </svg>
        {expanded ? 'Свернуть до недели' : 'Показать весь месяц'}
      </button>
    </div>
  );
};

export default WeekStrip;
