/* eslint-disable @typescript-eslint/no-explicit-any */
// Характеризующие тесты раскладки после ухода правой области.
//
// Что здесь закреплено и почему именно это. До редизайна ветка, сведения о
// чате и профиль делили ЧЕТВЁРТУЮ колонку справа, и вокруг неё была построена
// механика «намерение против возможности»: открыть просили всегда, а
// показывали, только если колонка помещалась. Колонки больше нет — ветка
// замещает переписку, сведения стали окном. Тесты пинят три следствия, каждое
// из которых легко потерять при следующей правке:
//
// 1. Переписка НЕ размонтируется, пока открыта ветка. Это и есть выполнение
//    требования «возврат из ветки не теряет позицию прокрутки основного
//    чата»: восстанавливать scrollTop не нужно, если лента никуда не девалась.
// 2. Сведения открываются окном на ЛЮБОЙ ширине, а не колонкой на широкой.
// 3. Ветка и сведения больше не вытесняют друг друга: раньше сведения
//    занимали ту же колонку и ветка на время пряталась.

import { render, act, waitFor } from '@testing-library/react';
import {
  makeSocket, makeApi, stub, props, resetProps, setViewport, MOBILE_VIEWPORT,
  FakeSocket, FakeApi,
} from './Chat.harness';

let socket: FakeSocket;
let api: FakeApi;

vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('@/shared/api/client', () => ({ default: new Proxy({}, { get: (_t, k) => (...a: any[]) => (api as any)[k](...a) }) }));

vi.mock('./ChatList', () => ({ default: stub('ChatList') }));
vi.mock('./ChatWindow', () => ({ default: stub('ChatWindow') }));
vi.mock('./MessageInput', () => ({ default: stub('MessageInput') }));
vi.mock('@/features/threads/ThreadPanel', () => ({ default: stub('ThreadPanel') }));
vi.mock('@/features/threads/ThreadInbox', () => ({ default: stub('ThreadInbox') }));
vi.mock('@/features/contacts/UserInfoModal', () => ({ default: stub('UserInfoModal') }));
vi.mock('@/features/groups/GroupInfoModal', () => ({ default: stub('GroupInfoModal') }));
vi.mock('@/features/groups/GeneralChatInfoModal', () => ({ default: stub('GeneralChatInfoModal') }));
vi.mock('@/features/notifications/NotificationStack', () => ({ default: stub('NotificationStack') }));
vi.mock('@/app/NavRail', async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real, default: stub('NavRail') };
});

const Chat = (await import('./Chat')).default;

/** Широкое окно: раньше именно здесь правая колонка и открывалась. */
const DESKTOP_VIEWPORT = 1600;

const mount = async () => {
  const view = render(<Chat />);
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(props.ChatList).toBeTruthy());
  return view;
};

const openChatAndThread = async () => {
  await act(async () => { props.ChatList.onSelectChat('general'); });
  await waitFor(() => expect(props.ChatWindow).toBeTruthy());
  await act(async () => { props.ChatWindow.onOpenThread(42, false); });
  await waitFor(() => expect(props.ThreadPanel).toBeTruthy());
};

beforeEach(() => {
  resetProps();
  setViewport(DESKTOP_VIEWPORT);
  socket = makeSocket();
  api = makeApi();
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('userId', '1');
  localStorage.setItem('username', 'alice');
  localStorage.setItem('accountType', 'staff');
  localStorage.setItem('lastHomeDay', new Date().toLocaleDateString('sv-SE'));
});

afterEach(() => localStorage.clear());

// ---------------------------------------------------------------------------
// Ветка замещает переписку, но не разбирает её
// ---------------------------------------------------------------------------

test('переписка остаётся смонтированной, пока открыта ветка', async () => {
  // Ключевой тест всей правки. Ветка накрывает колонку переписки, а не
  // подменяет её содержимое: размонтируй ленту — и возврат из ветки вернёт
  // человека вниз переписки, то есть туда, откуда он не уходил. Позиция
  // прокрутки хранится не в состоянии, а в самом живом узле.
  await mount();
  await openChatAndThread();

  expect(props.ChatWindow).toBeTruthy();
  expect(props.ThreadPanel).toBeTruthy();
});

test('возврат из ветки оставляет ту же переписку открытой', async () => {
  await mount();
  await openChatAndThread();

  await act(async () => { props.ThreadPanel.onClose(); });

  await waitFor(() => expect(props.ThreadPanel).toBeFalsy());
  expect(props.ChatWindow).toBeTruthy();
});

test('ветка открывается и на узком экране — от ширины она больше не зависит', async () => {
  // Раньше на десктопе ветка показывалась, только если для четвёртой колонки
  // хватало места, и «намерение» приходилось хранить отдельно от «факта».
  // Замещающей панели места хватает всегда, поэтому проверяем оба края.
  setViewport(MOBILE_VIEWPORT);
  await mount();
  await openChatAndThread();

  expect(props.ThreadPanel).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Сведения и профиль — окно, а не колонка
// ---------------------------------------------------------------------------

test('сведения о чате открываются окном и на широком окне тоже', async () => {
  await mount();

  await act(async () => { props.ChatList.onOpenGeneralInfo(); });

  await waitFor(() => expect(props.GeneralChatInfoModal).toBeTruthy());
});

test('открытые сведения не прячут ветку — они больше не делят с ней место', async () => {
  // Прежде сведения занимали ту же колонку и ветка на их время исчезала:
  // человек просил именно сведения, и колонка была одна. Окно ничего ни у кого
  // не отнимает, поэтому обе поверхности живут одновременно.
  await mount();
  await openChatAndThread();

  await act(async () => { props.ChatList.onOpenGeneralInfo(); });

  await waitFor(() => expect(props.GeneralChatInfoModal).toBeTruthy());
  expect(props.ThreadPanel).toBeTruthy();
});

test('уход в другой раздел закрывает и ветку, и сведения', async () => {
  // Окно о конкретной переписке, оставшееся висеть поверх «Календаря», человек
  // прочтёт как поломку.
  await mount();
  await openChatAndThread();
  await act(async () => { props.ChatList.onOpenGeneralInfo(); });
  await waitFor(() => expect(props.GeneralChatInfoModal).toBeTruthy());

  await act(async () => { props.NavRail.onSelect('calendar'); });

  await waitFor(() => expect(props.ThreadPanel).toBeFalsy());
  expect(props.GeneralChatInfoModal).toBeFalsy();
});
