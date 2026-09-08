import { act, render, screen } from '@testing-library/react';
import SectionLoading from './SectionLoading';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('мгновенная загрузка не мигает надписью', () => {
  // Раздел обычно приезжает сразу; мелькнувшее «Загрузка…» читается как
  // рывок, а не как забота.
  render(<SectionLoading />);
  expect(screen.queryByText('Загрузка…')).toBeNull();
});

test('затянулось — появляется «Загрузка…»', () => {
  render(<SectionLoading />);
  act(() => { vi.advanceTimersByTime(300); });
  expect(screen.getByText('Загрузка…')).toBeInTheDocument();
});

test('затянулось надолго — говорим про слабую связь, а не молчим', () => {
  // Бесконечное «Загрузка…» неотличимо от зависшего приложения.
  render(<SectionLoading />);
  act(() => { vi.advanceTimersByTime(6500); });
  expect(screen.getByText(/связь слабая/)).toBeInTheDocument();
});
