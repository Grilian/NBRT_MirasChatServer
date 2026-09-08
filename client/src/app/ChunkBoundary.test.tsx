import { fireEvent, render, screen } from '@testing-library/react';
import ChunkBoundary from './ChunkBoundary';

const Boom: React.FC<{ message: string }> = ({ message }) => { throw new Error(message); };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('не доехавший кусок объясняется как обновление, а не как поломка', () => {
  // Живая находка на выкладке 08.09.2026: имя файла раздела содержит хэш, при
  // обновлении старые исчезают, nginx отдаёт на их месте index.html — и экран
  // становится пустым, без единого слова.
  render(
    <ChunkBoundary>
      <Boom message="Failed to fetch dynamically imported module: /assets/TasksPanel-abc.js" />
    </ChunkBoundary>,
  );

  expect(screen.getByText('Приложение обновилось')).toBeInTheDocument();
  expect(screen.getByText(/ничего не потеряно/)).toBeInTheDocument();
});

test('любая другая поломка тоже не оставляет пустой экран', () => {
  render(<ChunkBoundary><Boom message="что-то своё" /></ChunkBoundary>);
  expect(screen.getByText('Что-то пошло не так')).toBeInTheDocument();
});

test('кнопка перезагружает страницу', () => {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });

  render(<ChunkBoundary><Boom message="Loading chunk 5 failed" /></ChunkBoundary>);
  fireEvent.click(screen.getByRole('button', { name: 'Обновить страницу' }));

  expect(reload).toHaveBeenCalled();
});

test('пока всё хорошо — граница ничего не рисует от себя', () => {
  render(<ChunkBoundary><div>раздел</div></ChunkBoundary>);
  expect(screen.getByText('раздел')).toBeInTheDocument();
});
