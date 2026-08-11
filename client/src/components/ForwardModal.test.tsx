import React from 'react';
import { render } from '@testing-library/react';

// AUTOFOCUS_ON_OPEN считается на этапе загрузки модуля и спрашивает
// matchMedia, которого в jsdom нет — заглушаем весь модуль (import'ы
// поднимаются выше любого кода, присвоить window.matchMedia уже поздно).
jest.mock('../utils/autoFocus', () => ({ AUTOFOCUS_ON_OPEN: false }));

import ForwardModal from './ForwardModal';
import { acquireStandardKeyboardResizeMode } from '../utils/mobileKeyboard';

const mockRelease = jest.fn();
jest.mock('../utils/mobileKeyboard', () => ({
  acquireStandardKeyboardResizeMode: jest.fn(),
}));

// Под окном остаётся смонтированный composer переписки, держащий Android в
// overlay-режиме: WebView под клавиатуру не сжимается, а окно центрируется по
// всему экрану — поле «Куда переслать» стоит внизу карточки и уходит под IME.
// Пока окно открыто, оно обязано забирать штатный adjustResize.
test('окно пересылки берёт штатный режим клавиатуры и отдаёт его при закрытии', () => {
  // Реализацию мока задаём внутри теста: CRA сбрасывает моки перед каждым,
  // и заданная в фабрике jest.mock она бы не дожила до запуска.
  (acquireStandardKeyboardResizeMode as jest.Mock).mockReturnValue(mockRelease);

  const { unmount } = render(
    <ForwardModal
      items={[{ id: 1, text: 'Привет', author: 'Пётр', hasImage: false }]}
      targets={[{ id: 'general', name: 'Общий чат', section: 'general' }]}
      onClose={jest.fn()}
      onConfirm={jest.fn()}
    />
  );

  expect(acquireStandardKeyboardResizeMode).toHaveBeenCalledTimes(1);
  expect(mockRelease).not.toHaveBeenCalled();

  unmount();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
