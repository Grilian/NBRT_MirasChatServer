import React from 'react';
import { act, render, screen } from '@testing-library/react';
import NotificationStack, { ToastNotification } from './NotificationStack';

jest.mock('./Avatar', () => () => <div />);

const threadToast: ToastNotification = {
  chatId: 'general',
  threadRootId: 42,
  title: 'Ветка · Общий чат',
  body: 'Иванов: Сообщение в ветке',
  count: 1,
  revision: 1,
};

// Тост ищется по паре (chatId, threadRootId). Пока автоскрытие и смахивание
// звали onDismiss только с chatId, уведомление ветки не находилось: оно
// оставалось висеть до нажатия крестика.
test('автоскрытие тоста ветки передаёт threadRootId', () => {
  jest.useFakeTimers();
  const onDismiss = jest.fn();

  render(
    <NotificationStack toasts={[threadToast]} durationMs={5000} onOpen={jest.fn()} onDismiss={onDismiss} />
  );

  act(() => { jest.advanceTimersByTime(5000); });

  expect(onDismiss).toHaveBeenCalledWith('general', 42);
  jest.useRealTimers();
});

test('крестик тоста ветки тоже передаёт threadRootId', () => {
  const onDismiss = jest.fn();

  render(
    <NotificationStack toasts={[threadToast]} durationMs={0} onOpen={jest.fn()} onDismiss={onDismiss} />
  );

  act(() => { screen.getByLabelText('Закрыть уведомление').click(); });

  expect(onDismiss).toHaveBeenCalledWith('general', 42);
});
