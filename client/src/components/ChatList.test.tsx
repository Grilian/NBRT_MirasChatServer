import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatList, { Chat } from './ChatList';

const chats: Chat[] = [
  { id: 'self_1', name: 'Избранное', section: 'self', groupLabel: null },
  { id: 'chat_1_2', name: 'Анна', section: 'staff', groupLabel: null, userId: 2 },
];

function renderList(onSelectChat = jest.fn()) {
  const result = render(
    <ChatList
      selfName="Я"
      selfAvatarPath={null}
      statusPreset={null}
      statusCustom={null}
      onOpenStatus={() => {}}
      chats={chats}
      recentChats={chats}
      activeChat={null}
      onSelectChat={onSelectChat}
      onOpenDirectory={() => {}}
      searchQuery=""
      onSearchChange={() => {}}
      lastMessages={{}}
      unreadCounts={{}}
      favorites={[]}
      onToggleFavorite={() => {}}
      onMarkAllRead={() => {}}
      onRemoveContact={() => {}}
      onOpenUserInfo={() => {}}
      onOpenGroupInfo={() => {}}
      onCreateGroup={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  return { ...result, onSelectChat };
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn().mockReturnValue({ matches: false }),
  });
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
});

test('opens a chat from the recent strip', () => {
  const onSelectChat = jest.fn();
  const { container } = renderList(onSelectChat);

  const recentButtons = container.querySelectorAll<HTMLButtonElement>('.recent-chat');
  expect(recentButtons).toHaveLength(2);
  fireEvent.click(recentButtons[1]);
  expect(onSelectChat).toHaveBeenCalledWith('chat_1_2');
});

test('maps the mouse wheel to horizontal recent-chat scrolling', () => {
  const { container } = renderList();
  const strip = container.querySelector('.recent-chats') as HTMLDivElement;
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 300 });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 100 });

  fireEvent.wheel(strip, { deltaY: 42, deltaX: 0 });
  expect(strip.scrollLeft).toBe(42);
});

test('collapses mobile search on list scroll and restores focus from the magnifier', () => {
  (window.matchMedia as jest.Mock).mockReturnValue({ matches: true });
  const { container } = renderList();
  const list = container.querySelector('.roster-list') as HTMLDivElement;
  Object.defineProperty(list, 'scrollTop', { configurable: true, value: 30 });

  fireEvent.scroll(list);
  expect(container.querySelector('.roster')).toHaveClass('is-search-collapsed');

  fireEvent.click(screen.getByLabelText('Открыть поиск чатов'));
  expect(container.querySelector('.roster')).not.toHaveClass('is-search-collapsed');
  expect(screen.getByPlaceholderText('Поиск')).toHaveFocus();
});
