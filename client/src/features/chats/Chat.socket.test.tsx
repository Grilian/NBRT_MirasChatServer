/* eslint-disable @typescript-eslint/no-explicit-any */
// Характеризующие тесты: сокет-события -> состояние.
//
// Закрепляют поведение ПЕРЕД разбором Chat.tsx на части. Это не проверка
// «правильно ли задумано» — это слепок того, как есть сейчас, чтобы переезд
// кода нельзя было провести с тихой потерей.

import { render, act, waitFor } from '@testing-library/react';
import { makeSocket, makeApi, stub, props, resetProps, message, FakeSocket, FakeApi } from './Chat.harness';

let socket: FakeSocket;
let api: FakeApi;

vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('@/shared/api/client', () => ({ default: new Proxy({}, { get: (_t, k) => (...a: any[]) => (api as any)[k](...a) }) }));

// Дети подменены заглушками: тесты проверяют логику самого Chat.tsx, а не
// отрисовку ленты и списка. Разметка при редизайне поменяется вся — договор
// по пропсам обязан пережить переезд.
vi.mock('./ChatList', () => ({ default: stub('ChatList') }));
vi.mock('./ChatWindow', () => ({ default: stub('ChatWindow') }));
vi.mock('./MessageInput', () => ({ default: stub('MessageInput') }));
vi.mock('@/features/home/HomeSection', () => ({ default: stub('HomeSection') }));
vi.mock('@/features/calendar/CalendarSection', () => ({ default: stub('CalendarSection') }));
vi.mock('@/features/files/FilesSection', () => ({ default: stub('FilesSection') }));
vi.mock('@/features/contacts/PeopleSection', () => ({ default: stub('PeopleSection') }));
vi.mock('@/features/tasks/TasksPanel', () => ({ default: stub('TasksPanel') }));
vi.mock('@/features/threads/ThreadPanel', () => ({ default: stub('ThreadPanel') }));
vi.mock('@/features/threads/ThreadInbox', () => ({ default: stub('ThreadInbox') }));
vi.mock('@/features/notifications/NotificationStack', () => ({ default: stub('NotificationStack') }));
vi.mock('@/features/settings/SettingsPanel', () => ({ default: stub('SettingsPanel') }));

// Платформенные модули: в jsdom нет ни Capacitor, ни Notification.
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }));
vi.mock('@/shared/platform/mobileNotify', () => ({
  isNativeMobile: false,
  ensureMobileNotificationPermission: vi.fn(),
  showMobileNotification: vi.fn(),
  dismissMobileNotifications: vi.fn(),
  dismissAllMobileNotifications: vi.fn(),
  onMobileNotificationTap: vi.fn(() => () => {}),
}));
vi.mock('@/shared/platform/mobilePush', () => ({
  initMobilePush: vi.fn(), unregisterMobilePush: vi.fn(), dismissAllPushNotifications: vi.fn(),
}));
vi.mock('@/shared/platform/desktopNotify', () => ({
  ensureDesktopNotificationPermission: vi.fn(),
  showDesktopNotification: vi.fn(),
  dismissDesktopNotification: vi.fn(),
  dismissAllDesktopNotifications: vi.fn(),
}));

const Chat = (await import('./Chat')).default;

const mount = async () => {
  const view = render(<Chat />);
  // Дать разойтись всем запросам, которые уходят на монтировании.
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(props.ChatList || props.HomeSection).toBeTruthy());
  return view;
};

beforeEach(() => {
  resetProps();
  socket = makeSocket();
  api = makeApi();
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('userId', '1');
  localStorage.setItem('username', 'alice');
  localStorage.setItem('displayName', 'Алиса');
  // Иначе первый запуск за день уводит на «Главную», и до списка чатов
  // тестам пришлось бы кликать.
  localStorage.setItem('lastHomeDay', new Date().toLocaleDateString('sv-SE'));
});

afterEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------

test('входящее в открытый чат попадает в ленту', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });

  await act(async () => { socket.fire('chat_message', message({ chat_id: 'general', text: 'первое' })); });

  await waitFor(() => {
    expect(props.ChatWindow.messages.map((m: any) => m.text)).toContain('первое');
  });
});

test('открытый чат при НЕ сфокусированном окне всё равно считается непрочитанным', async () => {
  // Ключевое правило, и оно неочевидное: «чат открыт» — ещё не «человек это
  // видит». Свёрнутое в трей окно с открытым чатом раньше считалось
  // просмотром, и сообщение проглатывалось молча: ни счётчика, ни
  // уведомления, сразу «прочитано». Условие — windowFocused И открытая
  // переписка И отсутствие окон поверх неё (conversationVisible).
  // В jsdom document.hasFocus() ложен, то есть это ветка «окно не в фокусе».
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });

  await act(async () => { socket.fire('chat_message', message({ chat_id: 'general' })); });

  await waitFor(() => expect(props.ChatList.unreadCounts.general).toBe(1));
});

test('в сфокусированном окне с открытым чатом счётчик не растёт', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  // Фокус приходит событием — сразу после выбора чата состояние ещё прежнее.
  await act(async () => { window.dispatchEvent(new Event('focus')); });

  await act(async () => { socket.fire('chat_message', message({ chat_id: 'general' })); });
  await act(async () => { await Promise.resolve(); });

  expect(props.ChatList.unreadCounts.general ?? 0).toBe(0);
});

test('задвоенное событие не даёт +2 к счётчику', async () => {
  // Реальный случай: при провисании сети сокет переподключается, на сервере
  // ненадолго остаётся прежняя комната, и событие приходит дважды. Лишняя
  // единица висела в бейдже до перезахода.
  await mount();
  const dup = message({ chat_id: 'chat_1_5' });

  await act(async () => {
    socket.fire('chat_message', dup);
    socket.fire('chat_message', dup);
  });

  await waitFor(() => expect(props.ChatList.unreadCounts.chat_1_5).toBe(1));
});

test('входящее в ДРУГОЙ чат в ленту не попадает, а поднимает счётчик', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });

  await act(async () => {
    socket.fire('chat_message', message({ chat_id: 'chat_1_2', text: 'в другом чате' }));
  });

  await waitFor(() => expect(props.ChatList.unreadCounts.chat_1_2).toBe(1));
  expect(props.ChatWindow.messages.map((m: any) => m.text)).not.toContain('в другом чате');
});

test('своё же сообщение, вернувшееся эхом, счётчик непрочитанного не поднимает', async () => {
  await mount();
  await act(async () => {
    socket.fire('chat_message', message({ chat_id: 'chat_1_9', sender_id: 1, text: 'моё' }));
  });
  await act(async () => { await Promise.resolve(); });
  expect(props.ChatList.unreadCounts.chat_1_9 ?? 0).toBe(0);
});

test('удаление сообщения убирает его из ленты, а не помечает плашкой', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  const m = message({ chat_id: 'general', text: 'сотрётся' });
  await act(async () => { socket.fire('chat_message', m); });
  await waitFor(() => expect(props.ChatWindow.messages).toHaveLength(1));

  await act(async () => { socket.fire('message_deleted', { id: m.id, chat_id: 'general' }); });

  // Ни плейсхолдера «Сообщение удалено», ни пустого пузыря: строка уходит
  // из ленты целиком — вторая линия защиты поверх редактирования выдачи
  // на сервере.
  await waitFor(() => {
    expect(props.ChatWindow.messages.some((x: any) => x.id === m.id && !x.deleted)).toBe(false);
  });
});

test('чужая правка сообщения доезжает до ленты', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  const m = message({ chat_id: 'general', text: 'было' });
  await act(async () => { socket.fire('chat_message', m); });
  await waitFor(() => expect(props.ChatWindow.messages).toHaveLength(1));

  await act(async () => {
    socket.fire('message_edited', { id: m.id, chat_id: 'general', text: 'стало', edited_at: '2026-09-07' });
  });

  await waitFor(() => {
    expect(props.ChatWindow.messages.find((x: any) => x.id === m.id).text).toBe('стало');
  });
});

test('очистка переписки опустошает ленту открытого чата', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  await act(async () => { socket.fire('chat_message', message({ chat_id: 'general' })); });
  await waitFor(() => expect(props.ChatWindow.messages).toHaveLength(1));

  await act(async () => { socket.fire('chat_cleared', { chat_id: 'general' }); });

  await waitFor(() => expect(props.ChatWindow.messages).toHaveLength(0));
});

test('архивация вложения снимает картинку, но само сообщение остаётся', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  const m = message({ chat_id: 'general', text: 'с картинкой', file_path: '/uploads/users/1/images/a.webp' });
  await act(async () => { socket.fire('chat_message', m); });
  await waitFor(() => expect(props.ChatWindow.messages).toHaveLength(1));

  await act(async () => {
    socket.fire('attachment_archived', { id: m.id, chat_id: 'general', archived_at: Date.now() });
  });

  await waitFor(() => {
    const row = props.ChatWindow.messages.find((x: any) => x.id === m.id);
    expect(row).toBeTruthy();
    expect(row.text).toBe('с картинкой');
    expect(row.file_path).toBeFalsy();
  });
});

const catalogReads = () => api.calls.filter(([, u]) => u.startsWith('/emoji/catalog')).length;

test('правка смайликов заставляет перечитать каталог отрисовки', async () => {
  await mount();
  const before = catalogReads();

  await act(async () => { socket.fire('emoji_changed'); });
  // Чтение отложено: см. EMOJI_RELOAD_DELAY_MS в Chat.tsx.
  await waitFor(() => expect(catalogReads()).toBeGreaterThan(before), { timeout: 3000 });
});

test('всплеск правок схлопывается в ОДНО чтение каталога', async () => {
  // Администратор включает десяток смайликов подряд, и на каждое нажатие
  // прилетает своё `emoji_changed`. Каталог весит 140 КБ сжатыми и
  // перечитывается целиком: двадцать правок при тридцати клиентах — под сотню
  // мегабайт на ровном месте. Настоящая дельта осталась незакрытым вопросом,
  // но всплеск обязан стоить одного чтения, а не десяти.
  await mount();
  const before = catalogReads();

  await act(async () => {
    for (let i = 0; i < 10; i += 1) socket.fire('emoji_changed');
  });

  await waitFor(() => expect(catalogReads()).toBe(before + 1), { timeout: 3000 });
  // И дальше не догоняет: отложенное чтение было одно, а не десять подряд.
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  expect(catalogReads()).toBe(before + 1);
});

test('серверные события, на которые никто не подписан, — осиротевшие', () => {
  // Не проверка «должно работать», а фиксация текущего положения дел:
  // calendar_notification сервер шлёт, а слушателя у него нет — приглашения и
  // напоминания доходят только пушем, то есть только на Android. Тест обязан
  // упасть, когда слушателя заведут, чтобы заметку в OPEN_QUESTIONS обновили
  // вместе с кодом. Так и вышло с `auth_error` 08.09.2026: он был осиротевшим,
  // слушателя завели — тест упал и переехал строкой ниже.
  act(() => { render(<Chat />); });
  expect(socket.listens('calendar_notification')).toBe(false);
  // А эти подписаны — если подписка потеряется при переезде, тест это покажет.
  expect(socket.listens('auth_error')).toBe(true);
  expect(socket.listens('chat_message')).toBe(true);
  expect(socket.listens('emoji_changed')).toBe(true);
  expect(socket.listens('chat_cleared')).toBe(true);
  expect(socket.listens('attachment_archived')).toBe(true);
  expect(socket.listens('reactions_changed')).toBe(true);
  expect(socket.listens('thread_message')).toBe(true);
});

test('недействительный сеанс отличается от недоступного сервера', async () => {
  // Живая находка на тестовом стенде: у него свой ключ подписи, приложение
  // осталось со старым токеном — и писало «Сервер недоступен. Повторное
  // подключение…» при полностью живом сервере. Ждать там нечего: пока человек
  // не войдёт заново, не изменится ничего.
  await mount();

  await act(async () => { socket.fire('connect'); });
  await act(async () => { socket.ack(null, { ok: false, error: 'invalid_token' }); });

  await waitFor(() => {
    expect(document.querySelector('.connection-banner')!.textContent)
      .toContain('Сеанс больше не действителен');
  });
  expect(document.body.textContent).not.toContain('Сервер недоступен');
  // Выход не делается сам: localStorage.clear() унёс бы и очередь
  // неотправленных сообщений — решает человек.
  expect(document.querySelector('.connection-banner-action')).toBeTruthy();
});

test('обычный отказ подтверждения по-прежнему читается как недоступный сервер', async () => {
  await mount();

  await act(async () => { socket.fire('connect'); });
  await act(async () => { socket.ack(null, { ok: false }); });

  await waitFor(() => {
    expect(document.querySelector('.connection-banner')!.textContent)
      .toContain('Сервер недоступен');
  });
});
