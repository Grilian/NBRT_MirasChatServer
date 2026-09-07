/* eslint-disable @typescript-eslint/no-explicit-any */
// Характеризующие тесты: очередь отправки.
//
// Самая невидимая часть приложения. Сообщение живёт локальным пузырём, пока
// сервер не подтвердит его, и от того, КАКАЯ ошибка вернулась, зависит,
// повторять отправку молча или отдавать её человеку. Ошибиться тут — значит
// либо вечно долбить сервер отказом, который никогда не пройдёт, либо
// показать «не отправлено» там, где надо было просто подождать сеть.

import { render, act, waitFor } from '@testing-library/react';
import { makeSocket, makeApi, stub, props, resetProps, FakeSocket, FakeApi } from './Chat.harness';

let socket: FakeSocket;
let api: FakeApi;

vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('../api/client', () => ({ default: new Proxy({}, { get: (_t, k) => (...a: any[]) => (api as any)[k](...a) }) }));

vi.mock('../components/ChatList', () => ({ default: stub('ChatList') }));
vi.mock('../components/ChatWindow', () => ({ default: stub('ChatWindow') }));
vi.mock('../components/MessageInput', () => ({ default: stub('MessageInput') }));
vi.mock('../components/HomeSection', () => ({ default: stub('HomeSection') }));
vi.mock('../components/CalendarSection', () => ({ default: stub('CalendarSection') }));
vi.mock('../components/FilesSection', () => ({ default: stub('FilesSection') }));
vi.mock('../components/PeopleSection', () => ({ default: stub('PeopleSection') }));
vi.mock('../tasks/TasksPanel', () => ({ default: stub('TasksPanel') }));
vi.mock('../components/ThreadPanel', () => ({ default: stub('ThreadPanel') }));
vi.mock('../components/ThreadInbox', () => ({ default: stub('ThreadInbox') }));
vi.mock('../components/NotificationStack', () => ({ default: stub('NotificationStack') }));
vi.mock('../components/SettingsPanel', () => ({ default: stub('SettingsPanel') }));

vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }));
vi.mock('../utils/mobileNotify', () => ({
  isNativeMobile: false,
  ensureMobileNotificationPermission: vi.fn(),
  showMobileNotification: vi.fn(),
  dismissMobileNotifications: vi.fn(),
  dismissAllMobileNotifications: vi.fn(),
  onMobileNotificationTap: vi.fn(() => () => {}),
}));
vi.mock('../utils/mobilePush', () => ({
  initMobilePush: vi.fn(), unregisterMobilePush: vi.fn(), dismissAllPushNotifications: vi.fn(),
}));
vi.mock('../utils/desktopNotify', () => ({
  ensureDesktopNotificationPermission: vi.fn(),
  showDesktopNotification: vi.fn(),
  dismissDesktopNotification: vi.fn(),
  dismissAllDesktopNotifications: vi.fn(),
}));

const Chat = (await import('./Chat')).default;

const mount = async () => {
  const view = render(<Chat />);
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(props.ChatList).toBeTruthy());
  await act(async () => { props.ChatList.onSelectChat('general'); });
  // Очередь не разгружается, пока сокет не авторизован, а авторизация — это
  // не отдельное событие, а ПОДТВЕРЖДЕНИЕ на 'user_online' с токеном.
  await act(async () => { socket.fire('connect'); });
  await act(async () => { socket.ack(null, { ok: true }); });
  await waitFor(() => expect(props.MessageInput).toBeTruthy());
  return view;
};

/** Отправить текст так же, как это делает поле ввода. */
const send = async (text: string) => {
  await act(async () => { await props.MessageInput.onSend(text); });
  await act(async () => { await Promise.resolve(); });
};

/** Пузыри очереди, которые ChatWindow получает вперемешку с обычными. */
const outgoing = () => (props.ChatWindow?.messages || []).filter((m: any) => m.client_message_id);

beforeEach(() => {
  resetProps();
  socket = makeSocket();
  api = makeApi();
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('userId', '1');
  localStorage.setItem('username', 'alice');
  localStorage.setItem('displayName', 'Алиса');
  localStorage.setItem('lastHomeDay', new Date().toLocaleDateString('sv-SE'));
});

afterEach(() => localStorage.clear());

// ---------------------------------------------------------------------------

test('отправленное появляется в ленте сразу, до ответа сервера', async () => {
  await mount();

  await send('привет');

  // Локальный пузырь есть, хотя сервер ещё ничего не подтвердил: иначе между
  // нажатием и ответом сети лента была бы пустой.
  await waitFor(() => expect(outgoing()).toHaveLength(1));
  expect(outgoing()[0].text).toBe('привет');
  expect(socket.lastSent('chat_message').text).toBe('привет');
});

test('подтверждение сервера превращает локальный пузырь в обычное сообщение', async () => {
  await mount();
  await send('привет');
  await waitFor(() => expect(outgoing()).toHaveLength(1));

  await act(async () => { socket.ack(null, { ok: true, messageId: 777, createdAt: '2026-09-07' }); });

  await waitFor(() => {
    const all = props.ChatWindow.messages;
    expect(all.some((m: any) => m.id === 777)).toBe(true);
    // Дубля быть не должно: локальная запись снимается по сквозному id.
    expect(all.filter((m: any) => m.text === 'привет')).toHaveLength(1);
  });
});

test('живое эхо тоже снимает локальный пузырь — дубля не появляется', async () => {
  // Эхо chat_message обычно приходит РАНЬШЕ подтверждения. Числового id у
  // локальной записи ещё нет, поэтому дедуп идёт по сквозному clientMessageId.
  await mount();
  await send('эхо');
  await waitFor(() => expect(outgoing()).toHaveLength(1));
  const clientId = socket.lastSent('chat_message').clientMessageId;

  await act(async () => {
    socket.fire('chat_message', {
      id: 801, chat_id: 'general', sender_id: 1, text: 'эхо',
      client_message_id: clientId, status: 'sent',
    });
  });

  await waitFor(() => {
    expect(props.ChatWindow.messages.filter((m: any) => m.text === 'эхо')).toHaveLength(1);
  });
});

test('отказ по праву писать — окончательный, повторять его бессмысленно', async () => {
  // write_not_allowed, muted, chat_forbidden и прочие отказы «по существу» не
  // пройдут и на десятый раз. Такое сообщение сразу отдаётся человеку как
  // «не отправлено», а не крутится в очереди, долбя сервер.
  await mount();
  await send('в канал, куда нельзя');

  await act(async () => { socket.ack(null, { ok: false, error: 'write_not_allowed' }); });

  await waitFor(() => expect(outgoing()[0].status).toBe('failed'));
});

test('молчание сети — не отказ: сообщение остаётся в очереди на повтор', async () => {
  await mount();
  await send('уедет позже');

  await act(async () => { socket.ack(new Error('timeout')); });

  await act(async () => { await Promise.resolve(); });
  // Наружу состояние очереди отдаётся полем status ленты: 'sending' — это тот
  // же pending. Пузырь показывается как «отправляется», а не «не отправлено»,
  // и уедет сам, когда вернётся сеть, — руками ничего делать не надо.
  expect(outgoing()[0].status).toBe('sending');
});

test('застрявшую отправку можно отменить, и она исчезает из ленты', async () => {
  // Раньше меню на таких сообщениях не открывалось вовсе, и застрявшую
  // картинку нельзя было ни убрать, ни скопировать её текст.
  await mount();
  await send('передумал');
  await waitFor(() => expect(outgoing()).toHaveLength(1));
  const clientId = outgoing()[0].client_message_id;

  await act(async () => { props.ChatWindow.onCancelOutgoing(clientId); });

  await waitFor(() => expect(outgoing()).toHaveLength(0));
});

test('очередь переживает перезапуск приложения', async () => {
  // Она хранится на устройстве под конкретным пользователем: закрыл приложение
  // с неотправленным — оно должно найтись после запуска, а не пропасть молча.
  const first = await mount();
  await send('переживёт перезапуск');
  await waitFor(() => expect(outgoing()).toHaveLength(1));
  first.unmount();

  resetProps();
  socket = makeSocket();
  await mount();

  await waitFor(() => {
    expect(outgoing().map((m: any) => m.text)).toContain('переживёт перезапуск');
  });
});
