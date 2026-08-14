import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import MessageInput from './MessageInput';

// Фокус ставится внутри requestAnimationFrame (композер в этот момент ещё
// меняет высоту под появившуюся панель), поэтому в тестах кадр прогоняем руками.
function flushFrame() {
  act(() => { jest.advanceTimersByTime(32); });
}

const noopSend = async () => ({ ok: true });

describe('MessageInput отправка', () => {
  test('кнопка отправки не забирает фокус у поля ввода', async () => {
    const onSend = jest.fn(noopSend);
    const { container } = render(<MessageInput onSend={onSend} />);

    const field = container.querySelector('.composer-input') as HTMLElement;
    field.focus();
    field.textContent = 'Привет';
    fireEvent.input(field);

    const sendButton = container.querySelector('.send-btn') as HTMLElement;
    // preventDefault на pointerdown — единственное, что удерживает фокус в поле:
    // без него Android переносит его на кнопку и закрывает клавиатуру, из-за
    // чего каждое следующее сообщение подряд требовало нового тапа по полю.
    let event = true;
    await act(async () => { event = fireEvent.pointerDown(sendButton); });

    expect(event).toBe(false); // preventDefault был вызван
    expect(document.activeElement).toBe(field);
    expect(onSend).toHaveBeenCalledWith('Привет');
  });

  test('одно нажатие отправляет ровно одно сообщение', async () => {
    const onSend = jest.fn(noopSend);
    const { container } = render(<MessageInput onSend={onSend} />);

    const field = container.querySelector('.composer-input') as HTMLElement;
    field.textContent = 'Раз';
    fireEvent.input(field);

    const sendButton = container.querySelector('.send-btn') as HTMLElement;
    // На ПК за pointerdown всегда приходит click; отправка не должна удвоиться.
    await act(async () => {
      fireEvent.pointerDown(sendButton);
      fireEvent.click(sendButton);
    });

    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('MessageInput ответ на сообщение', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('появление панели ответа само отдаёт фокус полю', () => {
    const { container, rerender } = render(<MessageInput onSend={noopSend} />);
    const field = container.querySelector('.composer-input') as HTMLElement;
    expect(document.activeElement).not.toBe(field);

    rerender(
      <MessageInput
        onSend={noopSend}
        replying={{ id: 7, text: 'Исходное', author: 'Борис', hasImage: false }}
      />,
    );
    flushFrame();

    // Иначе после «Ответить» приходилось дополнительно кликать по полю.
    expect(document.activeElement).toBe(field);
  });

  test('в выключенном композере фокус не запрашивается', () => {
    const { container, rerender } = render(<MessageInput onSend={noopSend} disabled />);
    const field = container.querySelector('.composer-input') as HTMLElement;

    rerender(
      <MessageInput
        onSend={noopSend}
        disabled
        replying={{ id: 7, text: 'Исходное', author: 'Борис', hasImage: false }}
      />,
    );
    flushFrame();

    expect(document.activeElement).not.toBe(field);
  });
});
