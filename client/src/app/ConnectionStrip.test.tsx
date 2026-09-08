import { act, render, screen } from '@testing-library/react';
import ConnectionStrip from './ConnectionStrip';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('при живой связи полосы нет вовсе', () => {
  render(<ConnectionStrip state="connected" onRelogin={vi.fn()} />);
  expect(document.querySelector('.connection-strip')).toBeNull();
});

test('короткое переподключение НЕ мигает полосой', () => {
  // Обычное подключение занимает доли секунды. Полоса на каждый переход
  // мигала бы без пользы и обесценивала бы саму себя.
  render(<ConnectionStrip state="connecting" onRelogin={vi.fn()} />);
  expect(document.querySelector('.connection-strip')).toBeNull();

  act(() => { vi.advanceTimersByTime(1600); });
  expect(screen.getByText('Соединение…')).toBeInTheDocument();
});

test('если тянется долго — так и говорим', () => {
  render(<ConnectionStrip state="connecting" onRelogin={vi.fn()} />);
  act(() => { vi.advanceTimersByTime(8500); });
  expect(screen.getByText(/Связь очень медленная/)).toBeInTheDocument();
});

test('отсутствие интернета и недействительный сеанс показываются сразу', () => {
  // Это не задержка, а состояние: само оно не пройдёт, ждать нечего.
  const { rerender } = render(<ConnectionStrip state="offline" onRelogin={vi.fn()} />);
  expect(screen.getByText(/Нет интернета/)).toBeInTheDocument();

  rerender(<ConnectionStrip state="session-invalid" onRelogin={vi.fn()} />);
  expect(screen.getByText(/Сеанс больше не действителен/)).toBeInTheDocument();
});

test('выход предлагается только там, где он и есть выход', () => {
  const onRelogin = vi.fn();
  const { rerender } = render(<ConnectionStrip state="server-unavailable" onRelogin={onRelogin} />);
  expect(screen.queryByRole('button')).toBeNull();

  rerender(<ConnectionStrip state="session-invalid" onRelogin={onRelogin} />);
  screen.getByRole('button', { name: 'Войти заново' }).click();
  expect(onRelogin).toHaveBeenCalled();
});
