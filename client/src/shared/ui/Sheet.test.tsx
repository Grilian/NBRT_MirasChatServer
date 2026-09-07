import { render, fireEvent } from '@testing-library/react';
import Sheet from './Sheet';
import { runTopBackInterceptor } from '@/shared/hooks/backInterceptors';

vi.mock('@/shared/platform/mobileKeyboard', () => ({
  acquireStandardKeyboardResizeMode: vi.fn(() => () => {}),
}));

test('клик мимо закрывает, клик внутри — нет', () => {
  const onClose = vi.fn();
  const { container, getByText } = render(
    <Sheet onClose={onClose} title="Ещё"><p>пункт</p></Sheet>,
  );

  fireEvent.click(getByText('пункт'));
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(container.querySelector('.sheet-overlay')!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape и аппаратный «Назад» закрывают', () => {
  const onClose = vi.fn();
  render(<Sheet onClose={onClose}><p>х</p></Sheet>);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);

  expect(runTopBackInterceptor()).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(2);
});

test('полоска-ручка есть всегда, заголовок — только заданный', () => {
  // Ручка — признак того, что панель пришла снизу и туда же уйдёт. Без неё
  // шторка читается как приклеенная к экрану панель.
  const bare = render(<Sheet onClose={() => {}}><p>х</p></Sheet>);
  expect(bare.container.querySelector('.sheet-grip')).toBeTruthy();
  expect(bare.container.querySelector('.sheet-title')).toBeNull();

  const titled = render(<Sheet onClose={() => {}} title="Ещё"><p>х</p></Sheet>);
  expect(titled.container.querySelector('.sheet-title')).toHaveTextContent('Ещё');
});

test('шторка объявлена диалогом, подпись берётся из заголовка', () => {
  const { container } = render(<Sheet onClose={() => {}} title="Ещё"><p>х</p></Sheet>);
  const card = container.querySelector('.sheet-card')!;
  expect(card).toHaveAttribute('role', 'dialog');
  expect(card).toHaveAttribute('aria-modal', 'true');
  expect(card).toHaveAttribute('aria-label', 'Ещё');
});
