import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import MessageInput from './MessageInput';
import ChatWindow from './ChatWindow';

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

describe('MessageInput прикрепление картинки', () => {
  // jsdom не реализует объектные URL вовсе — без заглушки падал бы сам
  // предпросмотр, а не проверяемое поведение.
  beforeAll(() => {
    (URL as any).createObjectURL = jest.fn(() => 'blob:preview');
    (URL as any).revokeObjectURL = jest.fn();
  });
  // Настоящий баг: File — это только ссылка на файл системы. Между выбором
  // картинки и нажатием «Отправить» Android успевает убрать временный файл
  // (камера, «Поделиться» из чужого приложения) или снимок удаляют из галереи.
  // Чтение падало ИМЕННО при отправке — с набранной подписью и без объяснения,
  // почему это случилось именно сейчас.

  function pickImage(container: HTMLElement, file: File) {
    const input = container.querySelector('input[type="file"][accept*="image"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    return act(async () => { fireEvent.change(input); });
  }

  /** Файл, который читается сейчас, но перестанет читаться позже. */
  function volatileFile(name = 'shot.jpg') {
    const file = new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/jpeg' });
    let alive = true;
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => (alive
        ? Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer)
        : Promise.reject(new DOMException('The requested file could not be read', 'NotReadableError'))),
      configurable: true,
    });
    return { file, vanish: () => { alive = false; } };
  }

  test('исчезнувший после выбора файл всё равно отправляется — байты уже свои', async () => {
    const onSend = jest.fn(noopSend);
    const { container } = render(<MessageInput onSend={onSend} />);

    const { file, vanish } = volatileFile();
    await pickImage(container, file);
    // Пока человек пишет подпись, система убирает исходный файл.
    vanish();

    const field = container.querySelector('.composer-input') as HTMLElement;
    field.textContent = 'что за ездовой бегемот?)';
    fireEvent.input(field);

    const sendButton = container.querySelector('.send-btn') as HTMLElement;
    await act(async () => { fireEvent.pointerDown(sendButton); });

    expect(onSend).toHaveBeenCalledTimes(1);
    const image = (onSend.mock.calls[0] as unknown[])[1] as { file: File } | undefined;
    expect(image).toBeTruthy();
    // Отправляется НАША копия, а не ссылка на исчезнувший файл.
    expect(image!.file).not.toBe(file);
    // jsdom не реализует File.arrayBuffer, поэтому проверяем сам факт копии:
    // те же байты и имя, но уже независимый от системы объект.
    expect(image!.file.size).toBe(4);
    expect(image!.file.name).toBe('shot.jpg');
    expect(container.querySelector('.composer-file-error')).toBeNull();
  });

  test('нечитаемый уже при выборе файл объясняется сразу, а не при отправке', async () => {
    const onSend = jest.fn(noopSend);
    const { container } = render(<MessageInput onSend={onSend} />);

    const { file, vanish } = volatileFile('gone.jpg');
    vanish();
    await pickImage(container, file);

    const error = container.querySelector('.composer-file-error');
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain('Выберите его заново');
    // Прикреплять нечего — превью не появилось.
    expect(container.querySelector('.composer-attachment')).toBeNull();
  });
});

describe('MessageInput всплывающие панели', () => {
  test('тап по сообщению за открытой скрепкой только закрывает скрепку', () => {
    const { container } = render(
      <>
        <ChatWindow
          chatId="test"
          messages={[{
            id: 1,
            text: 'Сообщение',
            sender_id: 2,
            username: 'user',
            created_at: '2026-08-19T10:00:00.000Z',
          }]}
          currentUserId={1}
          onStartEdit={() => {}}
          onDeleteMessage={() => {}}
        />
        <MessageInput onSend={noopSend} />
      </>,
    );

    fireEvent.click(container.querySelector('.attach-btn') as HTMLElement);
    expect(container.querySelector('.composer-attach-menu')).toBeInTheDocument();

    const row = container.querySelector('[data-msg-id="1"]') as HTMLElement;
    fireEvent.pointerDown(row, { clientX: 80, clientY: 80 });
    fireEvent.touchStart(row, { touches: [{ clientX: 80, clientY: 80 }] });
    fireEvent.pointerUp(row, { clientX: 80, clientY: 80 });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 80, clientY: 80 }] });
    fireEvent.mouseDown(row, { clientX: 80, clientY: 80 });
    fireEvent.mouseUp(row, { clientX: 80, clientY: 80 });
    fireEvent.click(row, { clientX: 80, clientY: 80 });

    expect(container.querySelector('.composer-attach-menu')).not.toBeInTheDocument();
    expect(container.querySelector('.msg-context-menu')).not.toBeInTheDocument();
  });
});

describe('MessageInput перетаскивание файлов', () => {
  beforeAll(() => {
    (URL as any).createObjectURL = jest.fn(() => 'blob:preview');
    (URL as any).revokeObjectURL = jest.fn();
  });

  function dropFiles(container: HTMLElement, files: File[]) {
    const form = container.querySelector('.composer') as HTMLElement;
    return act(async () => {
      fireEvent.drop(form, { dataTransfer: { files } });
    });
  }

  // Настоящий баг: перетащенный документ молча исчезал — stageFiles
  // отфильтровывал всё, что не картинка, и drop не давал этому файлу никакого
  // другого пути. Человек видел, что с картинками перетаскивание работает,
  // а с «некоторыми расширениями» — нет, без единой подсказки почему.
  test('перетащенный документ уходит файлом, а не пропадает молча', async () => {
    const onSendFile = jest.fn(async () => ({ ok: true }));
    const { container } = render(<MessageInput onSend={noopSend} onSendFile={onSendFile} />);

    const doc = new File([new Uint8Array([1, 2, 3])], 'смета.pdf', { type: 'application/pdf' });
    await dropFiles(container, [doc]);

    expect(onSendFile).toHaveBeenCalledWith(doc);
    // Документ не остаётся в поле как прикреплённая картинка.
    expect(container.querySelector('.composer-attachment')).toBeNull();
  });

  test('перетащенные картинка и документ одним броском расходятся по своим путям', async () => {
    const onSendFile = jest.fn(async () => ({ ok: true }));
    const { container } = render(<MessageInput onSend={noopSend} onSendFile={onSendFile} />);

    const image = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    const doc = new File([new Uint8Array([1, 2, 3])], 'report.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await dropFiles(container, [image, doc]);

    // Документ уходит отдельным сообщением сразу же, картинка — по-своему,
    // через onSendFile не проходит.
    expect(onSendFile).toHaveBeenCalledTimes(1);
    expect(onSendFile).toHaveBeenCalledWith(doc);
  });

  test('перетаскивание в отключённое поле ничего не отправляет', async () => {
    const onSendFile = jest.fn(async () => ({ ok: true }));
    const { container } = render(<MessageInput onSend={noopSend} onSendFile={onSendFile} disabled />);

    const doc = new File([new Uint8Array([1, 2, 3])], 'смета.pdf', { type: 'application/pdf' });
    await dropFiles(container, [doc]);

    expect(onSendFile).not.toHaveBeenCalled();
  });
});
