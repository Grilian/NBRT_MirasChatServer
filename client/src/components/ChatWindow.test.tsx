import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatWindow from './ChatWindow';
import { runTopBackInterceptor } from '../utils/backInterceptors';

const message = {
  id: 1,
  text: 'Фото',
  file_path: '/uploads/test.webp',
  sender_id: 2,
  username: 'user',
  created_at: '2026-08-09T10:00:00.000Z',
};

function renderWindow() {
  return render(
    <ChatWindow
      chatId="test"
      messages={[message]}
      currentUserId={1}
      onStartEdit={() => {}}
      onDeleteMessage={() => {}}
    />,
  );
}

describe('ChatWindow context menu', () => {
  test('renders a custom quick reaction as an image instead of its shortcode', () => {
    const { container } = render(
      <ChatWindow
        chatId="test"
        messages={[message]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        reactionEmoji={[':ink_happy:']}
        customEmoji={{
          ink_happy: {
            filePath: '/uploads/emoji/ink_happy.webp',
            fallback: '🙂',
          },
        }}
        onToggleReaction={() => {}}
      />,
    );

    const row = container.querySelector('[data-msg-id="1"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });

    const reaction = container.querySelector('.msg-menu-reaction') as HTMLElement;
    expect(reaction).toBeInTheDocument();
    expect(reaction).not.toHaveTextContent(':ink_happy:');
    expect(reaction.querySelector('img.custom-emoji')).toHaveAttribute(
      'src', expect.stringContaining('/uploads/emoji/ink_happy.webp'),
    );
  });

  test('first tap on an image outside the menu only dismisses the menu', () => {
    const { container } = renderWindow();
    const row = container.querySelector('[data-msg-id="1"]') as HTMLElement;
    const image = container.querySelector('.bubble-image') as HTMLElement;

    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });
    expect(container.querySelector('.msg-context-menu')).toBeInTheDocument();

    fireEvent.pointerDown(image);
    fireEvent.click(image);
    expect(container.querySelector('.msg-context-menu')).not.toBeInTheDocument();
    expect(container.querySelector('.lightbox-overlay')).not.toBeInTheDocument();

    fireEvent.click(image);
    expect(container.querySelector('.lightbox-overlay')).toBeInTheDocument();
  });

  test('tap on another message closes the old menu without opening a new one', () => {
    jest.useFakeTimers();
    const second = { ...message, id: 2, text: 'Второе', file_path: null };
    const { container } = render(
      <ChatWindow
        chatId="test"
        messages={[message, second]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
      />,
    );
    const firstRow = container.querySelector('[data-msg-id="1"]') as HTMLElement;
    const secondRow = container.querySelector('[data-msg-id="2"]') as HTMLElement;

    fireEvent.contextMenu(firstRow, { clientX: 100, clientY: 100 });
    expect(container.querySelector('.msg-context-menu')).toBeInTheDocument();

    // Реальный Android присылает все эти события для одного физического тапа.
    fireEvent.pointerDown(secondRow, { clientX: 120, clientY: 180 });
    fireEvent.touchStart(secondRow, { touches: [{ clientX: 120, clientY: 180 }] });
    fireEvent.pointerUp(secondRow, { clientX: 120, clientY: 180 });
    fireEvent.touchEnd(secondRow, { changedTouches: [{ clientX: 120, clientY: 180 }] });
    expect(container.querySelector('.msg-context-menu')).not.toBeInTheDocument();

    // WebView после preventDefault может не прислать click. Следующий тап всё
    // равно обязан сработать с первого раза, сразу после завершения жеста.
    act(() => { jest.advanceTimersByTime(40); });
    fireEvent.touchStart(secondRow, { touches: [{ clientX: 120, clientY: 180 }] });
    fireEvent.touchEnd(secondRow, { changedTouches: [{ clientX: 120, clientY: 180 }] });
    expect(container.querySelector('.msg-context-menu')).toBeInTheDocument();
    jest.useRealTimers();
  });

  test('uses the visible chat area as the context-menu height limit', () => {
    const { container } = renderWindow();
    const chat = container.querySelector('.conv-body') as HTMLElement;
    const row = container.querySelector('[data-msg-id="1"]') as HTMLElement;
    chat.getBoundingClientRect = () => ({
      x: 0, y: 100, top: 100, left: 0, right: 360, bottom: 500,
      width: 360, height: 400, toJSON: () => ({}),
    });

    fireEvent.contextMenu(row, { clientX: 100, clientY: 450 });

    expect(container.querySelector('.msg-menu-layer')).toHaveStyle({ maxHeight: '392px' });
  });
});

describe('ChatWindow threads', () => {
  test('shows an accessible reply entry and focuses a new thread composer', () => {
    const onOpenThread = jest.fn();
    const { getByRole } = render(
      <ChatWindow
        chatId="group_1"
        messages={[{ ...message, file_path: null, thread: {
          reply_count: 0, unread_count: 0, last_reply_at: null, recent_authors: [],
        } }]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onOpenThread={onOpenThread}
      />,
    );

    fireEvent.click(getByRole('button', { name: 'Ответить' }));
    expect(onOpenThread).toHaveBeenCalledWith(1, true);
  });

  test('opens an existing thread without forcing the keyboard', () => {
    const onOpenThread = jest.fn();
    const { getByRole } = render(
      <ChatWindow
        chatId="group_1"
        messages={[{ ...message, file_path: null, thread: {
          reply_count: 2,
          unread_count: 1,
          last_reply_at: '2026-08-09T10:05:00.000Z',
          recent_authors: [{ id: 2, username: 'user' }],
        } }]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onOpenThread={onOpenThread}
      />,
    );

    fireEvent.click(getByRole('button', { name: /2 ответа/ }));
    expect(onOpenThread).toHaveBeenCalledWith(1, false);
  });

  test('keeps a personal-chat thread in the context menu without an inline entry', () => {
    const onOpenThread = jest.fn();
    const { container, getByRole, queryByRole } = render(
      <ChatWindow
        chatId="1_2"
        messages={[{ ...message, file_path: null, thread: {
          reply_count: 0, unread_count: 0, last_reply_at: null, recent_authors: [],
        } }]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onOpenThread={onOpenThread}
      />,
    );

    expect(queryByRole('button', { name: 'Ответить' })).not.toBeInTheDocument();

    const row = container.querySelector('[data-msg-id="1"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });
    fireEvent.click(getByRole('button', { name: 'Ответить в ветке' }));
    expect(onOpenThread).toHaveBeenCalledWith(1, true);
  });

  test('shows an existing thread inline in a personal chat', () => {
    const onOpenThread = jest.fn();
    const { getByRole } = render(
      <ChatWindow
        chatId="1_2"
        messages={[{ ...message, file_path: null, thread: {
          reply_count: 2,
          unread_count: 0,
          last_reply_at: '2026-08-09T10:05:00.000Z',
          recent_authors: [{ id: 2, username: 'user' }],
        } }]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onOpenThread={onOpenThread}
      />,
    );

    fireEvent.click(getByRole('button', { name: /2 ответа/ }));
    expect(onOpenThread).toHaveBeenCalledWith(1, false);
  });
});

describe('ChatWindow строка под пузырём', () => {
  test('реакции и «Ответить» стоят в одном ряду, а не двумя строками', () => {
    const { container } = render(
      <ChatWindow
        chatId="group_1"
        messages={[{
          ...message,
          file_path: null,
          reactions: [{
            emoji: '👍',
            created_at: Date.now(),
            user: { id: 2, username: 'user', display_name: null, avatar_path: null },
          }],
          thread: { reply_count: 0, unread_count: 0, last_reply_at: null, recent_authors: [] },
        }]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onOpenThread={() => {}}
      />,
    );

    const row = container.querySelector('.msg-underrow') as HTMLElement;
    expect(row).toBeInTheDocument();
    // Обе части — прямые потомки одного ряда: разложенные по разным строкам,
    // они занимали двойную высоту и отрывали реакции от сообщения.
    expect(row.querySelector(':scope > .msg-reactions')).toBeInTheDocument();
    expect(row.querySelector(':scope > .thread-link')).toBeInTheDocument();
  });

  test('без реакций и без веток лишний ряд не создаётся', () => {
    const { container } = render(
      <ChatWindow
        chatId="1_2"
        messages={[{ ...message, file_path: null }]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
      />,
    );

    expect(container.querySelector('.msg-underrow')).not.toBeInTheDocument();
  });
});

describe('ChatWindow неотправленные сообщения', () => {
  const pending = {
    ...message,
    id: -1,
    text: 'Застрявшее',
    file_path: '/uploads/stuck.webp',
    sender_id: 1,
    status: 'failed' as const,
    client_message_id: 'local-1',
  };

  test('меню предлагает отменить отправку и повторить, но не удалить', () => {
    const onCancelOutgoing = jest.fn();
    const { container, getByRole, queryByRole } = render(
      <ChatWindow
        chatId="1_2"
        messages={[pending]}
        currentUserId={1}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onRetryOutgoing={() => {}}
        onCancelOutgoing={onCancelOutgoing}
      />,
    );

    const row = container.querySelector('[data-msg-id="-1"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });

    expect(getByRole('button', { name: 'Повторить отправку' })).toBeInTheDocument();
    // Ни ответить, ни переслать, ни удалить нельзя: на сервере сообщения ещё
    // нет, а id у него временный.
    expect(queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
    expect(queryByRole('button', { name: 'Переслать' })).not.toBeInTheDocument();
    // Реакцию ставить тоже не на что.
    expect(container.querySelector('.msg-menu-reactions')).not.toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: 'Отменить отправку' }));
    expect(onCancelOutgoing).toHaveBeenCalledWith('local-1');
  });

  test('удержание на неотправленном не включает режим выделения', () => {
    jest.useFakeTimers();
    try {
      const { container } = render(
        <ChatWindow
          chatId="1_2"
          messages={[pending]}
          currentUserId={1}
          onStartEdit={() => {}}
          onDeleteMessage={() => {}}
          onCancelOutgoing={() => {}}
        />,
      );

      const row = container.querySelector('[data-msg-id="-1"]') as HTMLElement;
      fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => { jest.advanceTimersByTime(900); });

      expect(container.querySelector('.msg-select-check')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ChatWindow докрутка ленты', () => {
  test('лента возвращается к низу, когда её высоту забрала панель ответа', () => {
    // Панель ответа/правки над полем ввода уменьшает высоту ленты уже ПОСЛЕ
    // того, как она доскроллилась вниз, и последнее сообщение уезжало под неё.
    // ResizeObserver в jsdom нет — подменяем, чтобы проверить саму проводку:
    // что лента наблюдается и изменение её высоты возвращает дно на место.
    const observers: Array<() => void> = [];
    const original = (global as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    };

    try {
      const { container } = render(
        <ChatWindow
          chatId="1_2"
          messages={[{ ...message, file_path: null }]}
          currentUserId={1}
          onStartEdit={() => {}}
          onDeleteMessage={() => {}}
        />,
      );

      const feed = container.querySelector('.conv-body') as HTMLElement;
      Object.defineProperty(feed, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(feed, 'clientHeight', { value: 600, configurable: true });
      feed.scrollTop = 400; // строго внизу
      fireEvent.scroll(feed);

      // Панель ответа отъела высоту — дно уехало за пределы видимого.
      Object.defineProperty(feed, 'clientHeight', { value: 520, configurable: true });
      act(() => { observers.forEach((notify) => notify()); });

      expect(feed.scrollTop).toBe(480);
    } finally {
      (global as unknown as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });
});

describe('ChatWindow стикеры', () => {
  const stickerMessage = {
    id: 42,
    text: '',
    file_path: null,
    sticker_id: 7,
    sticker_fallback: '🔥',
    sender_id: 1,
    username: 'me',
    created_at: '2026-08-09T10:00:00.000Z',
  };
  const catalog = { 7: { filePath: '/uploads/stickers/s.webp', emoji: '🔥' } };

  function renderSticker(overrides: Record<string, unknown> = {}) {
    return render(
      <ChatWindow
        chatId="test"
        messages={[{ ...stickerMessage, ...overrides }]}
        currentUserId={1}
        stickerCatalog={catalog}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
      />,
    );
  }

  test('стикер рисуется картинкой, но НЕ кнопкой и без просмотрщика', () => {
    const { container } = renderSticker();
    const sticker = container.querySelector('.bubble-sticker') as HTMLImageElement;

    expect(sticker).toBeInTheDocument();
    expect(sticker.tagName).toBe('IMG');
    // По требованию у стикера нет ни просмотра, ни увеличения: тап по нему
    // должен вести себя как тап по тексту. Кнопкой он быть не должен вовсе —
    // иначе получится фокусируемый элемент, глотающий жест.
    expect(sticker.closest('button')).toBeNull();

    fireEvent.click(sticker);
    expect(container.querySelector('.lightbox-overlay')).not.toBeInTheDocument();
  });

  test('использует единственный файл стикера — браузер сам воспроизводит WebP/GIF', () => {
    const animatedCatalog = { 7: { filePath: '/uploads/stickers/animated.webp', emoji: '🔥' } };
    const { container } = render(
      <ChatWindow
        chatId="test"
        messages={[stickerMessage]}
        currentUserId={1}
        stickerCatalog={animatedCatalog}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
      />,
    );

    expect(container.querySelector('.bubble-sticker')).toHaveAttribute(
      'src',
      expect.stringContaining('/uploads/stickers/animated.webp'),
    );
  });

  test('пузырь стикера без подложки и без полей', () => {
    const { container } = renderSticker();
    const bubble = container.querySelector('.bubble') as HTMLElement;
    // Прозрачный фон у стикера предполагается всегда, а не только когда сервер
    // пометил картинку суффиксом _a, как у обычных изображений.
    expect(bubble).toHaveClass('bubble-alpha-only');
    expect(bubble).toHaveClass('bubble-bare-image');
  });

  test('контекстное меню — то же, что у текста, но без «Копировать» и «Изменить»', () => {
    const { container, getByRole, queryByRole } = render(
      <ChatWindow
        chatId="test"
        messages={[stickerMessage]}
        currentUserId={1}
        stickerCatalog={catalog}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
        onStartReply={() => {}}
        onForward={() => {}}
      />,
    );

    const row = container.querySelector('[data-msg-id="42"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });

    // Применимое к стикеру — доступно.
    expect(getByRole('button', { name: 'Ответить' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Переслать' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
    // Неприменимое — нет. Текста у стикера не бывает, править и копировать нечего.
    expect(queryByRole('button', { name: 'Копировать' })).not.toBeInTheDocument();
    expect(queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument();
  });

  test('удалённый из пака стикер показывает эмодзи-заглушку, а не пустоту', () => {
    // Каталог пуст — картинки для этого id больше нет.
    const { container } = render(
      <ChatWindow
        chatId="test"
        messages={[stickerMessage]}
        currentUserId={1}
        stickerCatalog={{}}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
      />,
    );

    expect(container.querySelector('.bubble-sticker')).not.toBeInTheDocument();
    const fallback = container.querySelector('.bubble-sticker-fallback');
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent('🔥');
  });

  test('цитата на стикер показывает его эмодзи, а не «Фото»', () => {
    const { container } = render(
      <ChatWindow
        chatId="test"
        messages={[{
          ...stickerMessage,
          id: 43,
          sticker_id: null,
          text: 'ответ',
          reply_to_id: 42,
          reply_to_author: 'Борис',
          reply_to_text: '',
          reply_to_sticker_fallback: '🔥',
        }]}
        currentUserId={1}
        stickerCatalog={catalog}
        onStartEdit={() => {}}
        onDeleteMessage={() => {}}
      />,
    );

    const quote = container.querySelector('.bubble-reply-text');
    expect(quote).toHaveTextContent('🔥 Стикер');
    expect(quote).not.toHaveTextContent('Фото');
  });
});

test('аппаратный «Назад» снимает выделение, а не выходит из чата', () => {
  // На Android Back приходит в приложение и разбирается цепочкой перехватчиков
  // (utils/backInterceptors). Пока выделение в неё не входило, Back уводил с
  // экрана целиком — вместе с выбором и местом в переписке.
  const messages = [
    { id: 1, chat_id: 'chat_1_2', text: 'первое', sender_id: 2, created_at: '2026-08-15 10:00:00', status: 'read' },
    { id: 2, chat_id: 'chat_1_2', text: 'второе', sender_id: 1, created_at: '2026-08-15 10:01:00', status: 'read' },
  ];
  render(
    <ChatWindow
      chatId="chat_1_2"
      messages={messages as any}
      currentUserId={1}
      showAuthors={false}
      onScrollTop={() => {}}
      hasMore={false}
      loadingMore={false}
      unreadCount={0}
      onStartEdit={() => {}}
      editingId={null}
      onDeleteMessage={() => {}}
      onDeleteMessages={() => {}}
      onCreateTask={() => {}}
      onStartReply={() => {}}
      onForward={() => {}}
      reactionEmoji={[]}
      onToggleReaction={() => {}}
      onRemoveReaction={() => {}}
      onForwardToSelf={() => {}}
      selfChatName="Избранное"
    />,
  );

  // Пока выделения нет, Back в ленте перехватывать нечего.
  expect(runTopBackInterceptor()).toBe(false);

  fireEvent.contextMenu(screen.getByText('первое'));
  fireEvent.click(screen.getByText('Выделить'));
  expect(document.querySelectorAll('.msg-select-check').length).toBeGreaterThan(0);

  // Back поглощён выделением: экран остаётся, галочки снимаются. Вызов идёт
  // через act — перехватчик меняет состояние React.
  let handled = false;
  act(() => { handled = runTopBackInterceptor(); });
  expect(handled).toBe(true);
  expect(document.querySelectorAll('.msg-select-check').length).toBe(0);
  expect(screen.getByText('первое')).toBeInTheDocument();
});
