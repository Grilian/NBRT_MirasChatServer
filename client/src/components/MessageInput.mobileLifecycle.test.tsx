import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockAppStateHandler: ((state: { isActive: boolean }) => void) | null = null;
const mockHideKeyboard = jest.fn();
const mockRefreshResizeMode = jest.fn();

jest.mock('@capacitor/app', () => ({
  App: {
    addListener: (_event: string, handler: (state: { isActive: boolean }) => void) => {
      mockAppStateHandler = handler;
      return Promise.resolve({ remove: jest.fn() });
    },
  },
}));

jest.mock('../utils/mobileNotify', () => ({ isNativeMobile: true }));

jest.mock('../utils/mobileKeyboard', () => ({
  getLastMobileKeyboardHeight: () => 300,
  hideMobileKeyboard: () => { mockHideKeyboard(); return true; },
  showMobileKeyboard: jest.fn(),
  onKeyboardHide: () => () => {},
  onKeyboardShow: () => () => {},
  onKeyboardWillHide: () => () => {},
  onKeyboardWillShow: () => () => {},
  registerMobileInputSurfaceCloser: () => () => {},
  acquireChatKeyboardResizeMode: () => () => {},
  refreshMobileKeyboardResizeMode: () => mockRefreshResizeMode(),
}));

jest.mock('./ContentPicker', () => () => <div className="emoji-picker is-mobile-panel" />);

// eslint-disable-next-line import/first
import MessageInput from './MessageInput';

const noopSend = async () => ({ ok: true });

describe('MessageInput — блокировка и возврат Android', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockAppStateHandler = null;
    mockHideKeyboard.mockClear();
    mockRefreshResizeMode.mockClear();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('фон закрывает app-панель и снимает зарезервированную высоту', () => {
    const { container } = render(<MessageInput onSend={noopSend} />);
    const emojiButton = container.querySelector('.emoji-btn') as HTMLButtonElement;

    fireEvent.pointerDown(emojiButton);
    expect(container.querySelector('.composer')).toHaveClass('has-mobile-input-surface');
    expect(container.querySelector('.mobile-emoji-surface')).toHaveClass('is-emoji-visible');

    act(() => mockAppStateHandler?.({ isActive: false }));

    expect(container.querySelector('.composer')).not.toHaveClass('has-mobile-input-surface');
    expect(container.querySelector('.mobile-emoji-surface')).not.toHaveClass('is-emoji-visible');
    expect(mockHideKeyboard).toHaveBeenCalled();
  });

  test('resume закрывает пережившее фон состояние и повторно применяет overlay', () => {
    const { container } = render(<MessageInput onSend={noopSend} />);
    const emojiButton = container.querySelector('.emoji-btn') as HTMLButtonElement;
    fireEvent.pointerDown(emojiButton);

    act(() => mockAppStateHandler?.({ isActive: true }));

    expect(container.querySelector('.composer')).not.toHaveClass('has-mobile-input-surface');
    expect(container.querySelector('.mobile-emoji-surface')).not.toHaveClass('is-emoji-visible');
    expect(mockRefreshResizeMode).toHaveBeenCalledTimes(1);

    act(() => { jest.advanceTimersByTime(250); });
    expect(mockRefreshResizeMode).toHaveBeenCalledTimes(2);
  });
});
