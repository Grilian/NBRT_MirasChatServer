/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const get = vi.fn();
const put = vi.fn();

vi.mock('@/shared/api/client', () => ({
  default: {
    get: (...a: any[]) => get(...a),
    put: (...a: any[]) => put(...a),
  },
}));

const TracesSection = (await import('./TracesSection')).default;

const trace = (over: Record<string, unknown>) => ({
  origin_message_id: 1,
  origin_chat_id: 'general',
  note: null,
  created_at: 1_757_000_000_000,
  kind: 'messages',
  state: 'ok',
  chat: { id: 'general', name: 'Общий чат', kind: 'general', avatar_path: null },
  author: 'Алиса',
  text: 'исходное сообщение',
  message_created_at: '2026-09-15T10:00:00.000Z',
  ...over,
});

const mountWith = async (items: unknown[], props: Record<string, unknown> = {}) => {
  get.mockImplementation((url: string) => (url.startsWith('/traces?')
    ? Promise.resolve({ data: { items } })
    : Promise.resolve({ data: {} })));
  const view = render(<TracesSection onOpenMessage={() => {}} {...props} />);
  await waitFor(() => expect(screen.queryByText('Загрузка…')).not.toBeInTheDocument());
  return view;
};

beforeEach(() => { get.mockReset(); put.mockReset(); });

test('живой след показывает источник, подчищенный — только объяснение', async () => {
  await mountWith([
    trace({}),
    trace({
      origin_message_id: 2,
      state: 'cleaned',
      text: undefined,
      chat: undefined,
      deleted_by_name: 'Борис',
    }),
  ]);

  expect(screen.getByText('исходное сообщение')).toBeInTheDocument();
  expect(screen.getByText('Этот след был подчищен')).toBeInTheDocument();
  expect(screen.getByText(/Борис подчистил этот след/)).toBeInTheDocument();
});

test('скрытое у себя и закрытое правами объясняются РАЗНЫМИ словами', async () => {
  // Свалить их в одно «недоступно» значило бы соврать в одном из двух случаев:
  // скрытое человек прятал сам и может вернуть, закрытое — не его решение.
  await mountWith([
    trace({ origin_message_id: 3, state: 'hidden', text: undefined, chat: undefined }),
    trace({ origin_message_id: 4, state: 'forbidden', text: undefined, chat: undefined }),
  ]);

  expect(screen.getByText('Вы скрыли это сообщение у себя')).toBeInTheDocument();
  expect(screen.getByText('Нет доступа к исходному месту')).toBeInTheDocument();
});

test('«Найти след» есть только у живого следа', async () => {
  await mountWith([
    trace({}),
    trace({ origin_message_id: 5, state: 'forbidden', text: undefined, chat: undefined }),
  ]);

  expect(screen.getAllByText('Найти след')).toHaveLength(1);
  // Заметку можно оставить на любом: она принадлежит человеку, а не источнику.
  expect(screen.getAllByText('Добавить заметку')).toHaveLength(2);
});

test('переход спрашивает сервер заново, а не верит списку', async () => {
  // Между загрузкой раздела и нажатием человека могли вывести из группы.
  const opened: Array<[string, number]> = [];
  await mountWith([trace({})], { onOpenMessage: (c: string, m: number) => opened.push([c, m]) });

  get.mockImplementation((url: string) => (url === '/traces/1/origin'
    ? Promise.resolve({ data: { state: 'forbidden' } })
    : Promise.resolve({ data: { items: [trace({})] } })));

  await act(async () => { fireEvent.click(screen.getByText('Найти след')); });

  expect(opened).toEqual([]);
  expect(await screen.findByText('Нет доступа к исходному месту')).toBeInTheDocument();
});

test('ответ ветки открывается веткой, а не лентой', async () => {
  // Ответы вырезаны из всех выдач истории, и окно вокруг такого сообщения
  // привело бы в переписку без него.
  const threads: number[] = [];
  const opened: Array<[string, number]> = [];
  await mountWith([trace({})], {
    onOpenMessage: (c: string, m: number) => opened.push([c, m]),
    onOpenThread: (rootId: number) => threads.push(rootId),
  });

  get.mockImplementation((url: string) => (url === '/traces/1/origin'
    ? Promise.resolve({ data: { state: 'ok', chat_id: 'general', message_id: 1, thread_root_id: 42 } })
    : Promise.resolve({ data: { items: [trace({})] } })));

  await act(async () => { fireEvent.click(screen.getByText('Найти след')); });

  expect(threads).toEqual([42]);
  expect(opened).toEqual([]);
});

test('заметка сохраняется и сразу видна в строке', async () => {
  await mountWith([trace({})]);
  put.mockResolvedValue({ data: { note: 'вернуться после рефакторинга' } });

  fireEvent.click(screen.getByText('Добавить заметку'));
  fireEvent.change(screen.getByPlaceholderText('Зачем сохранили и к чему вернуться'), {
    target: { value: 'вернуться после рефакторинга' },
  });
  await act(async () => { fireEvent.click(screen.getByText('Сохранить')); });

  expect(put).toHaveBeenCalledWith('/traces/1/note', { note: 'вернуться после рефакторинга' });
  expect(await screen.findByText('вернуться после рефакторинга')).toBeInTheDocument();
});
