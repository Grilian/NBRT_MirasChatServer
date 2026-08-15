import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../api/client';
import HomeSection from './HomeSection';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const mockedApi = api as unknown as { get: jest.Mock };

const TASKS = [
  { id: 1, title: 'Смета', status: 'not_started' },
  { id: 2, title: 'Отчёт', status: 'in_progress' },
  { id: 3, title: 'Сделано', status: 'done' },
];

const at = (hours: number, minutes = 0) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
};

const EVENTS = {
  events: [
    { id: 2, event_id: 2, title: 'Планёрка', start_at: at(10, 30) },
    { id: 1, event_id: 1, title: 'Совещание', start_at: at(9) },
    { id: 3, event_id: 3, title: 'День открытых дверей', start_at: at(0), all_day: true },
  ],
  birthdays: [],
};

beforeEach(() => {
  mockedApi.get.mockReset();
  mockedApi.get.mockImplementation((url: string) => {
    if (url === '/tasks') return Promise.resolve({ data: TASKS });
    return Promise.resolve({ data: EVENTS });
  });
});

const setup = (unreadTotal = 18) => {
  const handlers = {
    onOpenChats: jest.fn(), onOpenTasks: jest.fn(), onOpenCalendar: jest.fn(), onOpenFiles: jest.fn(),
  };
  render(<HomeSection displayName="Алиса" unreadTotal={unreadTotal} {...handlers} />);
  return handlers;
};

test('здоровается по имени и показывает расписание дня по времени', async () => {
  setup();

  expect(screen.getByText(/Алиса/)).toBeInTheDocument();
  expect(await screen.findByText('Совещание')).toBeInTheDocument();

  // Расписание — список, а не число: «3 мероприятия» не говорит, к чему
  // готовиться, а именно за этим сюда и заходят утром.
  const titles = Array.from(document.querySelectorAll('.home-event-title')).map((n) => n.textContent);
  expect(titles).toEqual(['День открытых дверей', 'Совещание', 'Планёрка']);
  // Событие на весь день времени не имеет — так и подписано.
  expect(document.querySelectorAll('.home-event-time')[0].textContent).toBe('весь день');
});

test('счётчики и расписание ведут в свои разделы', async () => {
  const handlers = setup();
  await screen.findByText('Совещание');

  fireEvent.click(screen.getByText('Совещание').closest('button')!);
  expect(handlers.onOpenCalendar).toHaveBeenCalled();

  fireEvent.click(screen.getByText('непрочитанных сообщений').closest('button')!);
  expect(handlers.onOpenChats).toHaveBeenCalled();

  fireEvent.click(screen.getByText('назначенные задачи').closest('button')!);
  expect(handlers.onOpenTasks).toHaveBeenCalled();
});

test('на «Главной» есть вход в файлы — на телефоне другого входа туда нет', async () => {
  const handlers = setup();
  await screen.findByText('Совещание');

  fireEvent.click(screen.getByRole('button', { name: 'Файлы' }));
  expect(handlers.onOpenFiles).toHaveBeenCalled();

  // Эмодзи в кнопке помечен aria-hidden — в доступном имени остаётся слово.
  fireEvent.click(screen.getByRole('button', { name: 'Календарь' }));
  expect(handlers.onOpenCalendar).toHaveBeenCalled();
});

test('пустой день — это не ошибка, а сообщение о том, что ничего не горит', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(0);

  await waitFor(() => expect(screen.getByText(/Ничего не требует внимания/)).toBeInTheDocument());
  expect(document.querySelectorAll('.home-card').length).toBe(0);
  expect(document.querySelectorAll('.home-event').length).toBe(0);
});

test('счётчики склоняются по-русски', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [{ id: 1, status: 'in_progress' }] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(2);

  expect(await screen.findByText('назначенная задача')).toBeInTheDocument();
  expect(screen.getByText('непрочитанных сообщения')).toBeInTheDocument();
});
