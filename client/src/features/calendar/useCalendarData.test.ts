import { act, renderHook, waitFor } from '@testing-library/react';
import { useCalendarData } from './useCalendarData';

vi.mock('./api', () => ({
  __esModule: true,
  fetchRange: vi.fn(() => Promise.resolve({ events: [], birthdays: [] })),
  fetchCalendarMeta: vi.fn(() => Promise.resolve({ can_publish_global: false, google_calendars: [] })),
}));

beforeEach(() => {
  localStorage.clear();
});

test('вид календаря переживает перезаход', async () => {
  // Жалоба с личного тестирования: «включили Ленту — следующий вход должен
  // открываться Лентой». Настройка вида выбирается один раз и надолго.
  const first = renderHook(() => useCalendarData());
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  expect(first.result.current.mode).toBe('month');

  act(() => first.result.current.setMode('agenda'));
  first.unmount();

  const second = renderHook(() => useCalendarData());
  expect(second.result.current.mode).toBe('agenda');
});

test('мусор в хранилище не ломает календарь', () => {
  localStorage.setItem('calendarViewMode', 'пятилетка');
  const { result } = renderHook(() => useCalendarData());
  expect(result.current.mode).toBe('month');
});
