/* eslint-disable @typescript-eslint/no-explicit-any */
// Характеризующие тесты аппаратного «Назад» на Android.
//
// Зачем отдельным файлом. Раньше порядок закрытия держался списком из
// одиннадцати `if` в `Chat.tsx` — по строке на каждое окно, и поддерживался он
// руками. Список успел наполовину умереть: часть окон переехала на общий
// примитив и закрывалась перехватчиком ВЫШЕ по коду, так и не дойдя до своей
// строки. Теперь на примитиве все, список удалён, и порядок задаётся одним
// правилом: «последняя открытая поверхность закрывается первой».
//
// Проверять это обязательно тестом, а не чтением: окно, забытое в прежнем
// списке, вело себя не «немного иначе», а уводило экран из-под себя — само
// оставалось висеть поверх уже другого раздела.

import { render, act, waitFor } from '@testing-library/react';
import {
  makeSocket, makeApi, stub, props, resetProps, setViewport, MOBILE_VIEWPORT,
  FakeSocket, FakeApi, ME,
} from './Chat.harness';

let socket: FakeSocket;
let api: FakeApi;
let fireBack: () => void;

vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('@/shared/api/client', () => ({ default: new Proxy({}, { get: (_t, k) => (...a: any[]) => (api as any)[k](...a) }) }));

// Дети подменены, а вот ОКНА — нет: именно они регистрируют перехватчики, и
// подменив их, тест проверял бы пустоту.
vi.mock('./ChatList', () => ({ default: stub('ChatList') }));
vi.mock('./ChatWindow', () => ({ default: stub('ChatWindow') }));
vi.mock('./MessageInput', () => ({ default: stub('MessageInput') }));
vi.mock('@/features/threads/ThreadPanel', () => ({ default: stub('ThreadPanel') }));
vi.mock('@/features/threads/ThreadInbox', () => ({ default: stub('ThreadInbox') }));
vi.mock('@/features/notifications/NotificationStack', () => ({ default: stub('NotificationStack') }));
vi.mock('@/app/NavRail', async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real, default: stub('NavRail') };
});

vi.mock('@capacitor/app', () => ({
  App: {
    minimizeApp: vi.fn(),
    addListener: (event: string, handler: () => void) => {
      if (event === 'backButton') fireBack = handler;
      return Promise.resolve({ remove: vi.fn() });
    },
  },
}));
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
vi.mock('@/shared/platform/mobileKeyboard', () => ({
  closeMobileInputSurface: () => false,
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
  // Справочник и профиль тянутся ВНУТРИ обработчика `connect`, а не при
  // монтировании: пока сокет не поднялся и не подтвердил токен, приложение о
  // людях ничего не знает. Без этих двух строк карточка человека не
  // отрисуется, и тест проверял бы отсутствие окна.
  await act(async () => { socket.fire('connect'); });
  await act(async () => { socket.ack(null, { ok: true }); });
  await act(async () => { await Promise.resolve(); });
  return view;
};

const back = async () => { await act(async () => { fireBack(); }); };

beforeEach(() => {
  resetProps();
  setViewport(MOBILE_VIEWPORT);
  socket = makeSocket();
  api = makeApi();
  // Карточка человека рисуется, только если он есть в справочнике: пустой
  // ответ означал бы, что тест проверяет отсутствие окна.
  api.reply('/users', [{
    id: 2, username: 'bob', display_name: 'Борис Сотрудник', avatar_path: null,
    bio: null, phone: null, department: null, position: null, birth_date: null,
    group_name: null,
  }]);
  // Подмена по ПРЕФИКСУ: «/users» перекрывает и «/users/me», поэтому его
  // приходится вернуть отдельно и последним — последняя подмена проверяется
  // первой. Без этого приложение не получает своего пользователя вовсе.
  api.reply('/users/me', ME);
  fireBack = undefined as any;
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('userId', '1');
  localStorage.setItem('username', 'alice');
  localStorage.setItem('accountType', 'staff');
  localStorage.setItem('lastHomeDay', new Date().toLocaleDateString('sv-SE'));
});

afterEach(() => localStorage.clear());

const overlay = (root: HTMLElement, selector: string) => root.querySelector(selector);

test('шторка «Ещё» закрывается «Назад», а раздел не меняется', async () => {
  const view = await mount();
  await act(async () => { props.NavRail.onOpenMore(); });
  await waitFor(() => expect(overlay(view.container, '.sheet-card')).toBeTruthy());

  await back();

  expect(overlay(view.container, '.sheet-card')).toBeFalsy();
  expect(props.NavRail.active).toBe('chats');
});

test('карточка человека закрывается «Назад», не уводя экран', async () => {
  // Ровно тот случай, ради которого цепочка и существовала: Back обязан снять
  // карточку, а не выйти из раздела, оставив её висеть поверх другого экрана.
  const view = await mount();
  await act(async () => { props.ChatList.onOpenUserInfo(2); });
  await waitFor(() => expect(overlay(view.container, '.user-info-modal')).toBeTruthy());

  await back();

  expect(overlay(view.container, '.user-info-modal')).toBeFalsy();
  expect(props.NavRail.active).toBe('chats');
});

test('последняя открытая поверхность закрывается первой', async () => {
  // Позиция в разметке при этом ничего не решает: перехватчик регистрируется
  // при монтировании, то есть в момент открытия. Окно статуса объявлено в
  // разметке РАНЬШЕ карточки человека — и всё равно закрывается первым,
  // потому что открыто позже.
  const view = await mount();
  await act(async () => { props.ChatList.onOpenUserInfo(2); });
  await waitFor(() => expect(overlay(view.container, '.user-info-modal')).toBeTruthy());
  await act(async () => { props.ChatList.onOpenStatus(); });
  await waitFor(() => expect(overlay(view.container, '.status-sheet')).toBeTruthy());

  await back();
  expect(overlay(view.container, '.status-sheet')).toBeFalsy();
  expect(overlay(view.container, '.user-info-modal')).toBeTruthy();

  await back();
  expect(overlay(view.container, '.user-info-modal')).toBeFalsy();
  expect(props.NavRail.active).toBe('chats');
});

test('ветка закрывается «Назад» и возвращает переписку, а не список', async () => {
  const view = await mount();
  await act(async () => { props.ChatList.onSelectChat('general'); });
  await waitFor(() => expect(props.ChatWindow).toBeTruthy());
  await act(async () => { props.ChatWindow.onOpenThread(42, false); });
  await waitFor(() => expect(props.ThreadPanel).toBeTruthy());

  await back();

  expect(props.ThreadPanel).toBeFalsy();
  expect(props.ChatWindow).toBeTruthy();
  expect(view.container.querySelector('.conversation')).toBeTruthy();
});
