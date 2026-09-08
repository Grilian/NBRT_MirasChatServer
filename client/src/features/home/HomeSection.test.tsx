import type { Mock } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '@/shared/api/client';
import HomeSection, { untilLabel } from './HomeSection';
import { instantOf, todayKey } from '@/features/calendar/dates';

vi.mock('@/shared/api/client', () => ({
  __esModule: true,
  default: { get: vi.fn() },
}));

const mockedApi = api as unknown as { get: Mock };

const ME = 7;
/** Ничьи задачи, заведённые кем-то другим: их вправе взять любой, включая меня. */
const TASKS = [
  { id: 1, title: 'Смета', status: 'not_started', created_by: { id: 3 }, assignee: null },
  { id: 2, title: 'Отчёт', status: 'in_progress', created_by: { id: 3 }, assignee: null },
  { id: 3, title: 'Сделано', status: 'done', created_by: { id: 3 }, assignee: null },
];

// Компонент считает расписание в московском времени (см. calendar/dates.ts),
// поэтому фикстуры строим тем же instantOf, а не через локальные часы машины
// прогона: Date.setHours() берёт часовой пояс раннера, и на машине не в
// Europe/Moscow «9:00» превращалось бы в другой момент и другую подпись.
const at = (hours: number, minutes = 0) => instantOf(todayKey(), hours * 60 + minutes);

const EVENTS = {
  events: [
    { id: 2, event_id: 2, title: 'Планёрка', starts_at: at(10, 30), occurrence_start: at(10, 30) },
    { id: 1, event_id: 1, title: 'Совещание', starts_at: at(9), occurrence_start: at(9) },
    { id: 3, event_id: 3, title: 'День открытых дверей', starts_at: at(0), occurrence_start: at(0), all_day: true },
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

const setup = (unreadTotal = 18, over: Record<string, unknown> = {}) => {
  const handlers = {
    onOpenStatus: vi.fn(),
    onOpenChats: vi.fn(),
    onOpenTasks: vi.fn(),
    onOpenCalendar: vi.fn(),
    onOpenCalendarEvent: vi.fn(),
    onOpenFiles: vi.fn(),
  };
  render(
    <HomeSection displayName="Алиса" currentUserId={ME} unreadTotal={unreadTotal} {...handlers} {...over} />,
  );
  return handlers;
};

const tiles = () => Array.from(document.querySelectorAll('.home-stat'));

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
  expect(document.querySelectorAll('.home-event-time')[1].textContent).toBe('09:00');
  expect(document.querySelectorAll('.home-event-time')[2].textContent).toBe('10:30');
});

test('счётчики и расписание ведут в свои разделы', async () => {
  const handlers = setup();
  await screen.findByText('Совещание');

  fireEvent.click(screen.getByText('Совещание').closest('button')!);
  expect(handlers.onOpenCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ startAt: expect.any(Number) }));

  fireEvent.click(screen.getByText('непрочитанных сообщений').closest('button')!);
  expect(handlers.onOpenChats).toHaveBeenCalled();

  fireEvent.click(screen.getByText('задачи на мне').closest('button')!);
  expect(handlers.onOpenTasks).toHaveBeenCalled();
});

test('три плитки стоят ВСЕГДА, даже когда везде нули', async () => {
  // Решение против макета, где плитки показаны с числами. Ноль — такой же
  // ответ, как и любое другое число: «на сегодня ничего не назначено» человек
  // хочет видеть с утра не меньше, чем «три задачи». А ряд постоянного
  // состава читается сразу, тогда как прыгающий приходится перечитывать.
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(0);

  await waitFor(() => expect(screen.getByText('мероприятий сегодня')).toBeInTheDocument());
  expect(tiles()).toHaveLength(3);
  expect(tiles().map((t) => t.querySelector('.home-stat-count')!.textContent)).toEqual(['0', '0', '0']);
});

test('название события попадает в разметку ЦЕЛИКОМ', () => {
  // Оформление (перенос вместо многоточия) этим тестом не проверить: стилей в
  // jsdom нет вовсе, и getComputedStyle вернёт умолчания независимо от файла.
  // За оформление отвечает homeText.test.ts, читающий сам CSS; здесь —
  // только то, что компонент не режет строку сам.
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: TASKS })
    : Promise.resolve({
      data: {
        events: [{
          id: 9, event_id: 9, starts_at: at(14), occurrence_start: at(14),
          title: 'Экскурсия «Храмы и мечети Казани» для учеников старших классов',
        }],
        birthdays: [],
      },
    })));

  setup(7);

  // Ищем именно в РАСПИСАНИИ, а не по всей странице. Название события
  // появляется ещё и в карточке «Ближайшее событие» — но только когда событие
  // впереди, то есть в зависимости от часа прогона. Поиск по всей разметке
  // делал тест зависимым от времени суток: он падал на «нашлось несколько»
  // ровно в тот день, когда фикстура на 14:00 оказалась в будущем.
  return waitFor(() => {
    const titles = Array.from(document.querySelectorAll('.home-event-title'));
    expect(titles).toHaveLength(1);
    expect(titles[0].textContent).toBe('Экскурсия «Храмы и мечети Казани» для учеников старших классов');
  });
});

test('просроченные задачи попадают в «Требует внимания», а не теряются в общем счёте', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({
      data: [
        { id: 1, status: 'in_progress', due_at: Date.now() - 86_400_000, created_by: { id: 3 }, assignee: { id: ME } },
        { id: 2, status: 'not_started', due_at: Date.now() + 86_400_000, created_by: { id: 3 }, assignee: { id: ME } },
        // Завершённая просроченной не считается: срок ей уже безразличен.
        { id: 3, status: 'done', due_at: Date.now() - 86_400_000, created_by: { id: 3 }, assignee: { id: ME } },
      ],
    })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  const handlers = setup(0);

  const attention = await screen.findByText('1 задача просрочена');
  fireEvent.click(attention.closest('button')!);
  expect(handlers.onOpenTasks).toHaveBeenCalled();
});

test('без просроченного блок внимания говорит об этом прямо, а не пустует', async () => {
  setup(0);
  expect(await screen.findByText('Просроченного нет.')).toBeInTheDocument();
});

test('пустой день подписан как спокойный, а не как отсутствие данных', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(0);

  expect(await screen.findByText('Спокойный день')).toBeInTheDocument();
  expect(screen.getByText('На сегодня ничего не назначено.')).toBeInTheDocument();
});

test('статус открывается из шапки и показывает текущий', () => {
  const handlers = setup(0, { status: { emoji: '🌴', label: 'В отпуске' } });

  const button = screen.getByTitle('Изменить статус');
  expect(button).toHaveTextContent('В отпуске');
  fireEvent.click(button);
  expect(handlers.onOpenStatus).toHaveBeenCalled();
});

test('без статуса кнопка говорит «Я на связи»', () => {
  setup(0);
  expect(screen.getByTitle('Установить статус')).toHaveTextContent('Я на связи');
});

test('на «Главной» есть вход в файлы — на телефоне другого короткого входа нет', async () => {
  const handlers = setup();
  await screen.findByText('Совещание');

  fireEvent.click(screen.getByRole('button', { name: 'Файлы' }));
  expect(handlers.onOpenFiles).toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Календарь' }));
  expect(handlers.onOpenCalendar).toHaveBeenCalled();
});

test('счётчики склоняются по-русски', async () => {
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({ data: [{ id: 1, status: 'in_progress', created_by: { id: 3 }, assignee: { id: ME } }] })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(2);

  expect(await screen.findByText('задача на мне')).toBeInTheDocument();
  expect(screen.getByText('непрочитанных сообщения')).toBeInTheDocument();
});

test('плитка задач считает ТО ЖЕ, что покажет вкладка «Моя работа»', async () => {
  // Живая находка: «Главная» считала все активные задачи подряд и показывала
  // «1 задача в работе», а вкладка «Моя работа» была пуста — задача заведена
  // самим человеком и никому не назначена. Число, которое не сходится с тем,
  // куда оно ведёт, хуже отсутствующего.
  mockedApi.get.mockImplementation((url: string) => (url === '/tasks'
    ? Promise.resolve({
      data: [
        { id: 1, status: 'in_progress', created_by: { id: ME }, assignee: null },
        { id: 2, status: 'in_progress', created_by: { id: ME }, assignee: { id: 3 } },
        { id: 3, status: 'in_progress', created_by: { id: 3 }, assignee: { id: ME } },
      ],
    })
    : Promise.resolve({ data: { events: [], birthdays: [] } })));

  setup(0);

  await waitFor(() => expect(screen.getByText('задача на мне')).toBeInTheDocument());
  expect(tiles()[1].querySelector('.home-stat-count')!.textContent).toBe('1');
});

describe('«сколько у меня есть» до ближайшего события', () => {
  const now = at(12);

  test('минуты, часы и уже идущее', () => {
    // Время начала человек и так видит в расписании рядом; в сводке полезно
    // именно «сколько осталось».
    expect(untilLabel(now + 40 * 60_000, now)).toBe('через 40 минут');
    expect(untilLabel(now + 60 * 60_000, now)).toBe('через 1 час');
    expect(untilLabel(now + 3 * 3600_000, now)).toBe('через 3 часа');
    expect(untilLabel(now - 60_000, now)).toBe('идёт сейчас');
  });

  test('склонение не ломается на 11–14 и на 21', () => {
    expect(untilLabel(now + 11 * 60_000, now)).toBe('через 11 минут');
    expect(untilLabel(now + 21 * 60_000, now)).toBe('через 21 минуту');
  });
});
