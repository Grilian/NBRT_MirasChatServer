import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatWindow from './ChatWindow';

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
