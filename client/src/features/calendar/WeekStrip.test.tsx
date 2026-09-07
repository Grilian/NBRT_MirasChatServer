import { render, fireEvent } from '@testing-library/react';
import WeekStrip from './WeekStrip';
import { instantOf, startOfWeek, todayKey, addDays } from './dates';
import { CalendarOccurrence } from './types';

const occurrence = (day: string, title = 'Событие'): CalendarOccurrence => ({
  id: `${day}:${title}`,
  event_id: 1,
  occurrence_start: instantOf(day, 600),
  title,
  description: null,
  location: null,
  starts_at: instantOf(day, 600),
  ends_at: instantOf(day, 660),
  all_day: false,
  color: 'blue',
  is_task: false,
  completed: false,
  recurring: false,
  is_exception: false,
  reminders: [],
  recurrence: null,
  scope_kind: 'personal',
  scope_id: null,
} as CalendarOccurrence);

const setup = (over: Partial<React.ComponentProps<typeof WeekStrip>> = {}) => {
  const onSelect = vi.fn();
  const onToggleExpanded = vi.fn();
  const view = render(
    <WeekStrip
      anchor={todayKey()}
      onSelect={onSelect}
      occurrences={[]}
      expanded={false}
      onToggleExpanded={onToggleExpanded}
      {...over}
    />,
  );
  return { ...view, onSelect, onToggleExpanded };
};

test('свёрнутая полоса показывает ровно одну неделю', () => {
  const s = setup();
  expect(s.container.querySelectorAll('.cal-strip-week')).toHaveLength(1);
  expect(s.container.querySelectorAll('.cal-strip-day')).toHaveLength(7);
});

test('развёрнутая — весь месяц', () => {
  const s = setup({ expanded: true });
  // Сетка месяца всегда шесть недель: иначе высота полосы прыгала бы от
  // месяца к месяцу, и лента под ней уезжала бы вверх-вниз.
  expect(s.container.querySelectorAll('.cal-strip-week')).toHaveLength(6);
});

test('точка занятости стоит только у дней, где что-то есть', () => {
  // Числа с событиями и без обязаны различаться ДО того, как в них ткнули:
  // иначе выбор дня превращается в перебор.
  const week = startOfWeek(todayKey());
  const busyDay = addDays(week, 2);
  const s = setup({ anchor: week, occurrences: [occurrence(busyDay)] });

  const busy = s.container.querySelectorAll('.cal-strip-dot.is-busy');
  expect(busy).toHaveLength(1);
  expect(busy[0].closest('.cal-strip-day')).toHaveTextContent(String(Number(busyDay.slice(8))));
});

test('место под точку есть у каждого дня — числа не должны прыгать', () => {
  const s = setup();
  expect(s.container.querySelectorAll('.cal-strip-dot')).toHaveLength(7);
});

test('выбор дня уходит наверх, а не остаётся внутри полосы', () => {
  // Лента под полосой начинается с выбранного дня, поэтому владеть выбором
  // обязан календарь, а не сама полоса.
  const s = setup();
  fireEvent.click(s.container.querySelectorAll('.cal-strip-day')[3]);
  expect(s.onSelect).toHaveBeenCalledTimes(1);
});

test('кнопка разворота подписана тем, что сделает', () => {
  const collapsed = setup();
  expect(collapsed.container.querySelector('.cal-strip-toggle')).toHaveTextContent('Показать весь месяц');
  fireEvent.click(collapsed.container.querySelector('.cal-strip-toggle')!);
  expect(collapsed.onToggleExpanded).toHaveBeenCalled();

  const expanded = setup({ expanded: true });
  expect(expanded.container.querySelector('.cal-strip-toggle')).toHaveTextContent('Свернуть до недели');
});
