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

beforeEach(() => {
  mockedApi.get.mockReset();
  mockedApi.get.mockImplementation((url: string) => {
    if (url === '/tasks') return Promise.resolve({ data: TASKS });
    // fetchRange ходит в /calendar/events и ждёт events/birthdays.
    return Promise.resolve({ data: { events: [{ id: 1 }, { id: 2 }], birthdays: [{ id: 3 }] } });
  });
});

const setup = (unreadTotal = 18) => {
  const handlers = { onOpenChats: jest.fn(), onOpenTasks: jest.fn(), onOpenCalendar: jest.fn() };
  render(<HomeSection displayName="Алиса" unreadTotal={unreadTotal} {...handlers} />);
  return handlers;
};

test('здоровается по имени и показывает сводку дня', async () => {
  setup();

  expect(screen.getByText(/Алиса/)).toBeInTheDocument();
  // Завершённые задачи в сводку не идут: это список дел, а не отчёт.
  expect(await screen.findByText('назначенные задачи')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument(); // 2 события + 1 день рождения
  expect(screen.getByText('18')).toBeInTheDocument();
  expect(screen.getByText('непрочитанных сообщений')).toBeInTheDocument();
});

test('каждый блок — переход в свой раздел, а не просто цифра', async () => {
  const handlers = setup();
  await screen.findByText('назначенные задачи');

  fireEvent.click(screen.getByText('непрочитанных сообщений').closest('button')!);
  expect(handlers.onOpenChats).toHaveBeenCalled();

  fireEvent.click(screen.getByText('назначенные задачи').closest('button')!);
  expect(handlers.onOpenTasks).toHaveBeenCalled();

  fireEvent.click(screen.getByText(/мероприяти/).closest('button')!);
  expect(handlers.onOpenCalendar).toHaveBeenCalled();
});

test('пустой день — это не ошибка, а сообщение о том, что ничего не горит', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(0);

  await waitFor(() => expect(screen.getByText(/Ничего не требует внимания/)).toBeInTheDocument());
  expect(document.querySelectorAll('.home-card').length).toBe(0);
});

test('счётчики склоняются по-русски', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [{ id: 1, status: 'in_progress' }] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(2);

  expect(await screen.findByText('назначенная задача')).toBeInTheDocument();
  expect(screen.getByText('непрочитанных сообщения')).toBeInTheDocument();
});
