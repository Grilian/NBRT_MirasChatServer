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

// ===== Контекстное меню строки чата =====
//
// Кнопки «закрепить» и «убрать из списка» со строки убраны — все действия
// теперь в меню. Проверяем и состав меню, и то, что в группе нет пункта,
// который там был бы опасен.

function renderWithMenu(overrides: Partial<React.ComponentProps<typeof ChatList>> = {}) {
  const handlers = {
    onToggleFavorite: jest.fn(),
    onRemoveContact: jest.fn(),
    onToggleMute: jest.fn(),
    onMarkChatRead: jest.fn(),
    onClearChat: jest.fn(),
  };
  render(
    <ChatList
      selfName="Я"
      selfAvatarPath={null}
      statusPreset={null}
      statusCustom={null}
      onOpenStatus={() => {}}
      chats={[
        { id: 'chat_1_2', name: 'Анна', section: 'staff', groupLabel: null, userId: 2 },
        { id: 'group_5', name: 'Отдел', section: 'group', groupLabel: null },
      ]}
      recentChats={[]}
      activeChat={null}
      onSelectChat={() => {}}
      onOpenDirectory={() => {}}
      searchQuery=""
      onSearchChange={() => {}}
      lastMessages={{}}
      unreadCounts={{ chat_1_2: 3 }}
      favorites={[]}
      onMarkAllRead={() => {}}
      onOpenUserInfo={() => {}}
      onOpenGroupInfo={() => {}}
      onCreateGroup={() => {}}
      onOpenSettings={() => {}}
      mutedChatIds={[]}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

test('на строке чата больше нет кнопок закрепления и удаления', () => {
  renderWithMenu();
  expect(screen.queryByTitle('Закрепить')).not.toBeInTheDocument();
  expect(screen.queryByTitle('Убрать из списка')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Действия с чатом Анна' })).toBeInTheDocument();
});

test('в личном чате меню даёт все пять действий', () => {
  renderWithMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Действия с чатом Анна' }));

  for (const label of ['Закрепить', 'Пометить прочитанным', 'Отключить уведомления', 'Очистить переписку', 'Убрать из контактов']) {
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  }
});

test('в группе нельзя ни очистить переписку, ни убрать из контактов', () => {
  renderWithMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Действия с чатом Отдел' }));

  expect(screen.getByRole('button', { name: 'Закрепить' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Очистить переписку' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Убрать из контактов' })).not.toBeInTheDocument();
});

test('«Пометить прочитанным» не показывается, когда непрочитанного нет', () => {
  renderWithMenu({ unreadCounts: {} });
  fireEvent.click(screen.getByRole('button', { name: 'Действия с чатом Анна' }));
  expect(screen.queryByRole('button', { name: 'Пометить прочитанным' })).not.toBeInTheDocument();
});

test('пункты меню зовут переданные обработчики и закрывают меню', () => {
  const handlers = renderWithMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Действия с чатом Анна' }));
  fireEvent.click(screen.getByRole('button', { name: 'Очистить переписку' }));

  expect(handlers.onClearChat).toHaveBeenCalledWith('chat_1_2', 'Анна');
  expect(screen.queryByRole('button', { name: 'Закрепить' })).not.toBeInTheDocument();
});

test('заглушённый чат предлагает включить уведомления обратно', () => {
  const handlers = renderWithMenu({ mutedChatIds: ['chat_1_2'] });
  fireEvent.click(screen.getByRole('button', { name: 'Действия с чатом Анна' }));
  fireEvent.click(screen.getByRole('button', { name: 'Включить уведомления' }));

  expect(handlers.onToggleMute).toHaveBeenCalledWith('chat_1_2', false);
});
