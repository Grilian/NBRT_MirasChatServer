/* eslint-disable @typescript-eslint/no-explicit-any */
// Характеризующие тесты: навигация, восстановление вида и стек «Назад».
//
// Здесь закреплено то, что переживает перезапуск приложения и то, что вообще
// не видно на скриншотах. Аппаратный «Назад» на Android разбирается длинной
// цепочкой в Chat.tsx, и порядок в ней НЕ произволен: каждая строка стоит на
// своём месте потому, что иначе кнопка уводила экран из-под открытого окна,
// а окно оставалось висеть поверх уже другого экрана.

import { render, act, waitFor } from '@testing-library/react';
import { makeSocket, makeApi, stub, props, resetProps, setViewport, MOBILE_VIEWPORT, FakeSocket, FakeApi } from './Chat.harness';

let socket: FakeSocket;
let api: FakeApi;
let fireBack: () => void;

vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('@/shared/api/client', () => ({ default: new Proxy({}, { get: (_t, k) => (...a: any[]) => (api as any)[k](...a) }) }));

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
vi.mock('@/app/NavRail', async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real, default: stub('NavRail') };
});

const minimizeApp = vi.fn();
vi.mock('@capacitor/app', () => ({
  App: {
    minimizeApp: (...a: any[]) => minimizeApp(...a),
    addListener: (event: string, handler: () => void) => {
      if (event === 'backButton') fireBack = handler;
      return Promise.resolve({ remove: vi.fn() });
    },
  },
}));

// Стек «Назад» существует только на устройстве — на десктопе обработчик даже
// не регистрируется. Поэтому здесь платформа объявлена мобильной.
vi.mock('@/shared/platform/mobileNotify', () => ({
  isNativeMobile: true,
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
const closeMobileInputSurface = vi.fn((): boolean => false);
vi.mock('@/shared/platform/mobileKeyboard', () => ({
  closeMobileInputSurface: () => closeMobileInputSurface(),
  watchMobileKeyboard: vi.fn(() => () => {}),
  hideMobileKeyboard: vi.fn(),
  acquireChatKeyboardResizeMode: vi.fn(() => () => {}),
  acquireStandardKeyboardResizeMode: vi.fn(() => () => {}),
}));

const Chat = (await import('./Chat')).default;

const mount = async () => {
  const view = render(<Chat />);
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(fireBack).toBeTruthy());
  return view;
};

const back = async () => { await act(async () => { fireBack(); }); };

const seedSession = (accountType = 'staff') => {
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('userId', '1');
  localStorage.setItem('username', 'alice');
  localStorage.setItem('accountType', accountType);
};

beforeEach(() => {
  resetProps();
  // Стек «Назад» — это мобильный экран. В jsdom окно 1024×768, то есть
  // десктопная раскладка, где переписка и список сосуществуют, а ветка живёт
  // в правой колонке. На такой ширине проверялся бы не тот режим.
  setViewport(MOBILE_VIEWPORT);
  socket = makeSocket();
  api = makeApi();
  minimizeApp.mockClear();
  closeMobileInputSurface.mockClear();
  fireBack = undefined as any;
  seedSession();
  localStorage.setItem('lastHomeDay', new Date().toLocaleDateString('sv-SE'));
});

afterEach(() => localStorage.clear());

// ---------------------------------------------------------------------------
// Стартовый экран
// ---------------------------------------------------------------------------

test('первый запуск за день открывает «Главную», следующий — «Чаты»', async () => {
  // Сводка нужна утром: увидеть, что накопилось. На десятый запуск за день она
  // мешает — человек открывает приложение ради переписки. День хранится на
  // устройстве, синхронизировать его между устройствами незачем.
  localStorage.removeItem('lastHomeDay');
  const first = await mount();
  expect(props.NavRail.active).toBe('home');
  first.unmount();

  resetProps();
  await mount();
  expect(props.NavRail.active).toBe('chats');
});

// ---------------------------------------------------------------------------
// Переход между разделами
// ---------------------------------------------------------------------------

test('переход в раздел закрывает ветку и сведения и открывает раздел «сначала»', async () => {
  // Ветка и сведения принадлежат переписке, а не оболочке приложения. Если их
  // не сбросить, класс правой области переживает уход в «Настройки», и сетка
  // начинает ужимать основной раздел.
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  await act(async () => { props.ChatWindow.onOpenThread?.(42); });

  await act(async () => { props.NavRail.onSelect('calendar'); });

  expect(props.NavRail.active).toBe('calendar');
  expect(props.ThreadPanel).toBeFalsy();
  // Возврат в чаты открывает СПИСОК, а не последнюю переписку.
  await act(async () => { props.NavRail.onSelect('chats'); });
  expect(props.ChatList).toBeTruthy();
  expect(props.ChatWindow).toBeFalsy();
});

test('аккаунту «Интернет» недоступный раздел подменяется чатами', async () => {
  // Разделение типов аккаунтов держится не только интерфейсом: даже если в
  // сохранённом состоянии остался недоступный раздел, приложение уводит в чаты.
  seedSession('internet');
  await mount();

  await act(async () => { props.NavRail.onSelect('spaces'); });

  await waitFor(() => expect(props.NavRail.active).toBe('chats'));
});

// ---------------------------------------------------------------------------
// Стек «Назад»
// ---------------------------------------------------------------------------

test('«Назад» сначала закрывает нижнюю конструкцию ввода, ничего больше не трогая', async () => {
  // Emoji-панель — часть той же конструкции, что и системная клавиатура.
  // Пока она открыта, Back закрывает её, а навигация ждёт следующего нажатия.
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  closeMobileInputSurface.mockReturnValueOnce(true);

  await back();

  expect(closeMobileInputSurface).toHaveBeenCalled();
  // Переписка осталась открытой — навигации не было.
  expect(props.ChatWindow).toBeTruthy();
  expect(minimizeApp).not.toHaveBeenCalled();
});

test('«Назад» из переписки ведёт к списку чатов, а не сворачивает приложение', async () => {
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });

  await back();

  await waitFor(() => expect(props.NavRail.active).toBe('chats'));
  expect(minimizeApp).not.toHaveBeenCalled();
});

test('«Назад» из другого раздела возвращает к списку чатов, а не в переписку', async () => {
  // Тот же сброс, что и в goToSection: аппаратная кнопка возвращает к списку,
  // а не в переписку, открытую до ухода в другой раздел.
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  await act(async () => { props.NavRail.onSelect('tasks'); });

  await back();

  await waitFor(() => expect(props.NavRail.active).toBe('chats'));
  expect(props.ChatWindow).toBeFalsy();
});

test('«Назад» со списка чатов сворачивает приложение, а не убивает процесс', async () => {
  await mount();

  await back();

  expect(minimizeApp).toHaveBeenCalledTimes(1);
});

test('ветка закрывается раньше самой переписки', async () => {
  // Порядок в цепочке не косметика: закрой Back сначала переписку — ветка
  // осталась бы висеть поверх списка чатов.
  await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  await act(async () => { props.ChatWindow.onOpenThread?.(42); });
  await waitFor(() => expect(props.ThreadPanel).toBeTruthy());

  await back();
  expect(props.ChatWindow).toBeTruthy(); // переписка на месте

  await back();
  await waitFor(() => expect(props.NavRail.active).toBe('chats'));
});
