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
      currentUserId={1}
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
      currentUserId={1}
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
      mutedChatIds={[]}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

/** Меню строки открывается правым кликом — кнопки «⋮» в строке больше нет. */
function openMenu(name: string) {
  const row = screen.getByText(name).closest('.row') as HTMLElement;
  fireEvent.contextMenu(row);
}

test('в строке чата нет ни кнопок действий, ни кнопки меню', () => {
  renderWithMenu();
  expect(screen.queryByTitle('Закрепить')).not.toBeInTheDocument();
  expect(screen.queryByTitle('Убрать из списка')).not.toBeInTheDocument();
  expect(document.querySelector('.row-menu-btn')).toBeNull();

  // Правый клик по строке — единственный вход в меню на ПК.
  openMenu('Анна');
  expect(screen.getByRole('button', { name: 'Закрепить' })).toBeInTheDocument();
});

test('в личном чате меню даёт все пять действий', () => {
  renderWithMenu();
  openMenu('Анна');

  for (const label of ['Закрепить', 'Пометить прочитанным', 'Отключить уведомления', 'Очистить переписку', 'Убрать из контактов']) {
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  }
});

test('в группе нельзя ни очистить переписку, ни убрать из контактов', () => {
  renderWithMenu();
  openMenu('Отдел');

  expect(screen.getByRole('button', { name: 'Закрепить' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Очистить переписку' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Убрать из контактов' })).not.toBeInTheDocument();
});

test('«Пометить прочитанным» не показывается, когда непрочитанного нет', () => {
  renderWithMenu({ unreadCounts: {} });
  openMenu('Анна');
  expect(screen.queryByRole('button', { name: 'Пометить прочитанным' })).not.toBeInTheDocument();
});

test('пункты меню зовут переданные обработчики и закрывают меню', () => {
  const handlers = renderWithMenu();
  openMenu('Анна');
  fireEvent.click(screen.getByRole('button', { name: 'Очистить переписку' }));

  expect(handlers.onClearChat).toHaveBeenCalledWith('chat_1_2', 'Анна');
  expect(screen.queryByRole('button', { name: 'Закрепить' })).not.toBeInTheDocument();
});

test('заглушённый чат предлагает включить уведомления обратно', () => {
  const handlers = renderWithMenu({ mutedChatIds: ['chat_1_2'] });
  openMenu('Анна');
  fireEvent.click(screen.getByRole('button', { name: 'Включить уведомления' }));

  expect(handlers.onToggleMute).toHaveBeenCalledWith('chat_1_2', false);
});

// ===== Новый вид строки и фильтры =====

const PREVIEW_CHATS: Chat[] = [
  { id: 'chat_1_2', name: 'Анна', section: 'staff', groupLabel: null, userId: 2 },
  { id: 'group_5', name: 'Отдел', section: 'group', groupLabel: null },
  { id: 'group_7', name: 'Объявления', section: 'group', groupLabel: null, announcementsOnly: true },
  { id: 'general', name: 'Общий чат', section: 'general', groupLabel: null },
  { id: 'self_1', name: 'Избранное', section: 'self', groupLabel: null },
];

function renderRoster(overrides: Partial<React.ComponentProps<typeof ChatList>> = {}) {
  render(
    <ChatList
      selfName="Я"
      selfAvatarPath={null}
      statusPreset={null}
      statusCustom={null}
      currentUserId={1}
      onOpenStatus={() => {}}
      chats={PREVIEW_CHATS}
      recentChats={[]}
      activeChat={null}
      onSelectChat={() => {}}
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
      {...overrides}
    />,
  );
}

const rowOf = (name: string) => screen.getByText(name).closest('.row') as HTMLElement;

test('закрепление и время — одна плашка, а не два элемента строки', () => {
  renderRoster({
    favorites: ['chat_1_2'],
    lastMessages: {
      chat_1_2: { chat_id: 'chat_1_2', text: 'привет', created_at: '2026-08-15 10:00:00' },
    },
  });

  const stamp = rowOf('Анна').querySelector('.row-stamp');
  expect(stamp).not.toBeNull();
  expect(stamp!.className).toContain('is-pinned');
  // Внутри плашки и значок, и время — отдельной колонки под закрепление нет.
  expect(stamp!.querySelector('svg')).not.toBeNull();
  expect(stamp!.textContent).toMatch(/\d{2}:\d{2}/);
});

test('у своего последнего сообщения в превью те же галочки, что и в переписке', () => {
  renderRoster({
    lastMessages: {
      chat_1_2: {
        chat_id: 'chat_1_2', text: 'моё', created_at: '2026-08-15 10:00:00',
        sender_id: 1, status: 'read',
      },
      group_5: {
        chat_id: 'group_5', text: 'чужое', created_at: '2026-08-15 10:00:00',
        sender_id: 2, sender_name: 'Пётр', status: 'read',
      },
    },
  });

  expect(rowOf('Анна').querySelector('.row-check.is-read')).not.toBeNull();
  // У чужого сообщения статус относится к чтению собеседником — в списке он
  // ничего не значит и не показывается.
  expect(rowOf('Отдел').querySelector('.row-check')).toBeNull();
  // Зато в группе видно, кто написал.
  expect(rowOf('Отдел').textContent).toContain('Пётр:');
});

test('картинка в последнем сообщении даёт миниатюру перед текстом', () => {
  renderRoster({
    lastMessages: {
      chat_1_2: {
        chat_id: 'chat_1_2', text: '', created_at: '2026-08-15 10:00:00',
        sender_id: 2, file_path: '/uploads/users/2/images/x.webp',
      },
    },
  });

  const row = rowOf('Анна');
  expect(row.querySelector('.row-thumb')).not.toBeNull();
  expect(row.textContent).toContain('Фотография');
});

test('счётчик непрочитанных стоит в правой колонке под временем', () => {
  renderRoster({
    unreadCounts: { chat_1_2: 56 },
    lastMessages: { chat_1_2: { chat_id: 'chat_1_2', text: 'э', created_at: '2026-08-15 10:00:00' } },
  });

  const side = rowOf('Анна').querySelector('.row-side');
  expect(side).not.toBeNull();
  expect(side!.querySelector('.row-unread')!.textContent).toBe('56');
});

test('отключённые уведомления видно по значку у имени чата', () => {
  renderRoster({ mutedChatIds: ['group_5'] });

  const muted = rowOf('Отдел').querySelector('.row-muted');
  expect(muted).not.toBeNull();
  // Именно у имени: справа уже время, галочки и счётчик.
  expect(rowOf('Отдел').querySelector('.row-name')!.contains(muted!)).toBe(true);
  expect(rowOf('Анна').querySelector('.row-muted')).toBeNull();
});

test('фильтры отбирают список, не превращаясь в отдельные экраны', () => {
  renderRoster();
  // Array.from, а не спред: у проекта target ниже es2015, и спред по NodeList
  // не собирается (ловится только production-сборкой, тесты его переживают).
  const names = () => Array.from(document.querySelectorAll('.row-name span')).map((n) => n.textContent);

  expect(names()).toEqual(expect.arrayContaining(['Анна', 'Отдел', 'Объявления', 'Общий чат', 'Избранное']));

  fireEvent.click(screen.getByRole('tab', { name: 'Личные' }));
  expect(names()).toEqual(['Анна', 'Избранное']);

  fireEvent.click(screen.getByRole('tab', { name: 'Группы' }));
  expect(names()).toEqual(['Отдел']);

  // «Новостные» — канал-объявление и общий чат: их читают, а не обсуждают.
  fireEvent.click(screen.getByRole('tab', { name: 'Новостные' }));
  expect(names()).toEqual(['Объявления', 'Общий чат']);
});

test('«Мой статус» — отдельный блок над списком, а не первый чат', () => {
  renderRoster({ statusPreset: 'vacation' });

  const block = document.querySelector('.roster-mystatus');
  expect(block).not.toBeNull();
  expect(block!.closest('.roster-list')).toBeNull();
  expect(block!.textContent).toContain('Изменить статус');
});
