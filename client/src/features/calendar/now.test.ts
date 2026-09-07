import { resolveNow, isRunning } from './now';
import { CalendarOccurrence } from './types';

const H = 3600_000;
const NOON = new Date('2026-09-07T12:00:00Z').getTime();

const at = (over: Partial<CalendarOccurrence>): CalendarOccurrence => ({
  id: String(over.starts_at) + ':' + String(over.title),
  event_id: 1,
  occurrence_start: over.starts_at ?? 0,
  title: 'Событие',
  description: null,
  location: null,
  starts_at: 0,
  ends_at: 0,
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
  ...over,
} as CalendarOccurrence);

test('идущее сейчас и следующее разделены', () => {
  const running = at({ title: 'Экскурсия', starts_at: NOON - H, ends_at: NOON + H });
  const soon = at({ title: 'Планёрка', starts_at: NOON + 2 * H, ends_at: NOON + 3 * H });
  const past = at({ title: 'Утро', starts_at: NOON - 5 * H, ends_at: NOON - 4 * H });

  const state = resolveNow([past, soon, running], NOON);
  expect(state.current?.title).toBe('Экскурсия');
  expect(state.next?.title).toBe('Планёрка');
});

test('событие на весь день текущим НЕ считается', () => {
  // Формально оно идёт все сутки, и полоса «сейчас: книжная выставка, до
  // 23:59» висела бы весь день, вытесняя то, к чему действительно надо идти
  // через десять минут.
  const allDay = at({ title: 'Книжная выставка', starts_at: NOON - 12 * H, ends_at: NOON + 11 * H, all_day: true });
  const state = resolveNow([allDay], NOON);
  expect(state.current).toBeNull();
  expect(state.next).toBeNull();
  expect(isRunning(allDay, NOON)).toBe(false);
});

test('из пересекающихся текущим считается то, что закончится раньше', () => {
  // Ближайшая точка, где у человека что-то изменится.
  const long = at({ title: 'Дежурство', starts_at: NOON - 3 * H, ends_at: NOON + 4 * H });
  const short = at({ title: 'Звонок', starts_at: NOON - 10 * 60_000, ends_at: NOON + 20 * 60_000 });
  expect(resolveNow([long, short], NOON).current?.title).toBe('Звонок');
});

test('момент окончания уже не «сейчас», момент начала — уже «сейчас»', () => {
  // Границы важны: иначе на стыке двух встреч подряд минуту не идёт ничего
  // или идут обе.
  const ends = at({ title: 'Конец', starts_at: NOON - H, ends_at: NOON });
  const starts = at({ title: 'Начало', starts_at: NOON, ends_at: NOON + H });

  const state = resolveNow([ends, starts], NOON);
  expect(state.current?.title).toBe('Начало');
  expect(state.next).toBeNull();
});

test('когда ничего не идёт — только следующее', () => {
  const soon = at({ title: 'Встреча', starts_at: NOON + H, ends_at: NOON + 2 * H });
  const state = resolveNow([soon], NOON);
  expect(state.current).toBeNull();
  expect(state.next?.title).toBe('Встреча');
});

test('пустой день не выдумывает ни текущего, ни следующего', () => {
  expect(resolveNow([], NOON)).toEqual({ current: null, next: null });
});
