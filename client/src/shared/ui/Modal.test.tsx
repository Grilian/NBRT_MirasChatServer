import { render, fireEvent, act } from '@testing-library/react';
import type { Mock } from 'vitest';
import Modal, { ModalHead } from './Modal';
import { runTopBackInterceptor } from '@/shared/hooks/backInterceptors';
import { acquireStandardKeyboardResizeMode } from '@/shared/platform/mobileKeyboard';

const release = vi.fn();
vi.mock('@/shared/platform/mobileKeyboard', () => ({
  acquireStandardKeyboardResizeMode: vi.fn(),
}));

beforeEach(() => {
  release.mockClear();
  // Счётчик вызовов копится между тестами файла — без сброса проверка
  // «взяли ровно один раз» считала бы все предыдущие окна.
  (acquireStandardKeyboardResizeMode as Mock).mockClear();
  (acquireStandardKeyboardResizeMode as Mock).mockReturnValue(release);
});

// Окно держит четыре вещи, которые раньше каждый его вид помнил сам — и
// каждый забывал СВОЮ. Тесты закрепляют именно их.

test('клик мимо карточки закрывает, клик внутри — нет', () => {
  const onClose = vi.fn();
  const { container, getByText } = render(
    <Modal onClose={onClose}><p>содержимое</p></Modal>,
  );

  fireEvent.click(getByText('содержимое'));
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(container.querySelector('.modal-overlay')!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('persistent не закрывается промахом мимо карточки', () => {
  // Для окон, где закрытие теряет введённое: создание опроса, правка события.
  const onClose = vi.fn();
  const { container } = render(
    <Modal onClose={onClose} persistent><p>черновик</p></Modal>,
  );
  fireEvent.click(container.querySelector('.modal-overlay')!);
  expect(onClose).not.toHaveBeenCalled();
});

test('Escape закрывает', () => {
  const onClose = vi.fn();
  render(<Modal onClose={onClose}><p>х</p></Modal>);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('аппаратный «Назад» закрывает окно, а не экран под ним', () => {
  // Не встроенное в цепочку окно оставалось висеть поверх уже другого экрана.
  const onClose = vi.fn();
  render(<Modal onClose={onClose}><p>х</p></Modal>);

  const handled = runTopBackInterceptor();

  expect(handled).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('перехватчик «Назад» снимается при закрытии окна', () => {
  const onClose = vi.fn();
  const { unmount } = render(<Modal onClose={onClose}><p>х</p></Modal>);
  unmount();
  expect(runTopBackInterceptor()).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});

test('на время окна берётся штатный режим клавиатуры и отдаётся при закрытии', () => {
  // Пока открыта переписка, приложение держит Android в overlay-режиме:
  // композер двигает себя сам. Окно поверх неё об этом не знает, и его низ
  // уходил под клавиатуру — ровно там, где обычно стоит поле поиска.
  const { unmount } = render(<Modal onClose={() => {}}><p>х</p></Modal>);
  expect(acquireStandardKeyboardResizeMode).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();

  unmount();
  expect(release).toHaveBeenCalledTimes(1);
});

test('устаревший onClose не вызывается: перехватчик берёт свежий', () => {
  // Перехватчик и слушатель Escape регистрируются один раз, а onClose у
  // вызывающего кода пересоздаётся на каждой отрисовке.
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = render(<Modal onClose={first}><p>х</p></Modal>);
  rerender(<Modal onClose={second}><p>х</p></Modal>);

  act(() => { runTopBackInterceptor(); });

  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

test('вложенное окно получает свой слой', () => {
  // Одного z-index мало: при равном значении порядок в DOM решает, кто сверху,
  // а не то, какое окно открыли позже.
  const { container } = render(<Modal onClose={() => {}} nested><p>х</p></Modal>);
  expect(container.querySelector('.modal-overlay')).toHaveClass('modal-overlay-nested');
});

test('шапка рисует заголовок, подпись и рабочий крестик', () => {
  const onClose = vi.fn();
  const { getByText, getByLabelText } = render(
    <Modal onClose={onClose}>
      <ModalHead title="Переслать" subtitle="3 сообщ." onClose={onClose} />
    </Modal>,
  );
  expect(getByText('Переслать')).toBeInTheDocument();
  expect(getByText('3 сообщ.')).toBeInTheDocument();
  fireEvent.click(getByLabelText('Закрыть'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('окно объявлено диалогом для экранных читалок', () => {
  const { container } = render(
    <Modal onClose={() => {}} label="Пересылка"><p>х</p></Modal>,
  );
  const card = container.querySelector('.modal-card')!;
  expect(card).toHaveAttribute('role', 'dialog');
  expect(card).toHaveAttribute('aria-modal', 'true');
  expect(card).toHaveAttribute('aria-label', 'Пересылка');
});
