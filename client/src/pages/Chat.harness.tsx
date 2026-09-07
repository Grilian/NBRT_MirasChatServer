/* eslint-disable @typescript-eslint/no-explicit-any */
// Стенд для характеризующих тестов Chat.tsx.
//
// Зачем он есть. Chat.tsx — 3678 строк, 76 состояний и 35 эффектов, и в нём
// живёт то, чего не видно ни на одном скриншоте: раскладка сокет-событий по
// состоянию, восстановление раздела, стек «Назад», режимы клавиатуры Android,
// очередь отправки. Перед разбором файла на части это поведение нужно
// закрепить, иначе потеря обнаружится не в тестах, а у людей на проде.
//
// Тесты намеренно ходят ЧЕРЕЗ ПРОПСЫ детей, а не через разметку. Пропсы и есть
// договор между Chat.tsx и остальным приложением: разметка при редизайне
// поменяется вся, а договор обязан пережить переезд. Поэтому дети подменены
// заглушками, которые складывают свои пропсы в реестр, — тест дёргает нужный
// обработчик по имени и смотрит, что стало с состоянием.

import React from 'react';

// ---------------------------------------------------------------------------
// Реестр пропсов подменённых детей
// ---------------------------------------------------------------------------

export const props: Record<string, any> = {};

/**
 * Заглушка, запоминающая последние пропсы под своим именем.
 *
 * Запись УДАЛЯЕТСЯ при размонтировании — иначе `props.ChatWindow` оставался бы
 * правдивым и после того, как переписка закрылась, и проверка «панели больше
 * нет» молча проходила бы на устаревшем объекте.
 */
export const stub = (name: string) => {
  const Stub = (p: any) => {
    props[name] = p;
    React.useEffect(() => () => { delete props[name]; }, []);
    return <div data-testid={`stub-${name}`} />;
  };
  Stub.displayName = `Stub(${name})`;
  return Stub;
};

export const resetProps = () => {
  for (const k of Object.keys(props)) delete props[k];
};

/**
 * Размер окна для jsdom. По умолчанию там 1024×768 — то есть десктопная
 * раскладка, где переписка и список сосуществуют. Мобильные проверки обязаны
 * задавать ширину явно, иначе они молча проверяют не тот режим.
 */
export const setViewport = (width: number, height = 844) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
  window.dispatchEvent(new Event('resize'));
};

/** Эталон мобильного экрана из концепции редизайна. */
export const MOBILE_VIEWPORT = 390;

// ---------------------------------------------------------------------------
// Поддельный сокет
// ---------------------------------------------------------------------------

export interface FakeSocket {
  on: (event: string, handler: (...a: any[]) => void) => FakeSocket;
  off: (event: string, handler?: (...a: any[]) => void) => FakeSocket;
  emit: (event: string, ...a: any[]) => void;
  /** socket.io-шная форма отправки с ожиданием ответа. */
  timeout: (ms: number) => { emit: (event: string, ...a: any[]) => void };
  disconnect: () => void;
  close: () => void;
  connected: boolean;
  /** Что клиент отправил на сервер: [событие, ...аргументы]. */
  sent: Array<[string, ...any[]]>;
  /** Вызвать обработчики, навешенные приложением на это событие. */
  fire: (event: string, ...a: any[]) => void;
  /** Ответить на последнюю отправку с подтверждением: ack(null, {ok:true,...})
   *  — успех, ack(new Error('timeout')) — молчание сервера. */
  ack: (timeoutError: Error | null, response?: any) => void;
  /** Полезная нагрузка последней отправки данного события. */
  lastSent: (event: string) => any;
  /** Есть ли хоть один слушатель — сам по себе показатель: осиротевшее
   *  серверное событие означает функцию, которая до человека не доходит. */
  listens: (event: string) => boolean;
}

export const makeSocket = (): FakeSocket => {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  let pendingAck: ((timeoutError: Error | null, response?: any) => void) | null = null;
  const record = (event: string, ...a: any[]) => {
    socket.sent.push([event, ...a]);
    const maybeAck = a[a.length - 1];
    if (typeof maybeAck === 'function') pendingAck = maybeAck;
  };
  const socket: FakeSocket = {
    sent: [],
    connected: true,
    on(event, handler) {
      (handlers[event] ||= []).push(handler);
      return socket;
    },
    off(event, handler) {
      if (!handler) delete handlers[event];
      else handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
      return socket;
    },
    emit: record,
    timeout: () => ({ emit: record }),
    disconnect() {},
    close() {},
    fire(event, ...a) {
      (handlers[event] || []).forEach((h) => h(...a));
    },
    ack(timeoutError, response) {
      const fn = pendingAck;
      pendingAck = null;
      if (!fn) throw new Error('нет отправки, ожидающей подтверждения');
      fn(timeoutError, response);
    },
    lastSent(event) {
      const hit = [...socket.sent].reverse().find(([e]) => e === event);
      return hit ? hit[1] : undefined;
    },
    listens: (event) => (handlers[event] || []).length > 0,
  };
  return socket;
};

// ---------------------------------------------------------------------------
// Поддельный API
// ---------------------------------------------------------------------------

export const ME = {
  id: 1,
  username: 'alice',
  display_name: 'Алиса',
  avatar_path: null,
  chat_background_path: null,
  role: null,
  account_type: 'staff',
  self_chat_id: 'self_1',
  self_chat_name: 'Избранное',
  reaction_emoji: ['👍', '❤️'],
  muted: false,
  status_preset: null,
  status_custom: null,
  status_expires_at: null,
};

/** Что отдаётся на GET по умолчанию. Ключ — начало пути. */
const DEFAULT_GET: Array<[string, any]> = [
  ['/users/me', ME],
  ['/users', []],
  ['/contacts', []],
  ['/groups', []],
  ['/favorites', []],
  ['/unread', {}],
  ['/comments', []],
  ['/moderation/groups', []],
  ['/emoji/catalog', []],
  ['/stickers/catalog', []],
  ['/messages/meta/last', {}],
  ['/messages/meta/recent', []],
  ['/messages/threads', { messages: [] }],
  ['/messages/', { messages: [], hasMore: false }],
];

export interface FakeApi {
  get: (url: string, ...a: any[]) => Promise<{ data: any }>;
  post: (url: string, ...a: any[]) => Promise<{ data: any }>;
  put: (url: string, ...a: any[]) => Promise<{ data: any }>;
  delete: (url: string, ...a: any[]) => Promise<{ data: any }>;
  /** Подменить ответ на конкретный путь (сверяется по началу строки). */
  reply: (prefix: string, data: any) => void;
  /** Все запрошенные адреса — по ним видно, что приложение вообще дёргает. */
  calls: Array<[string, string]>;
}

export const makeApi = (): FakeApi => {
  const overrides: Array<[string, any]> = [];
  const pick = (url: string) => {
    const hit = [...overrides, ...DEFAULT_GET].find(([p]) => url.startsWith(p));
    return hit ? hit[1] : {};
  };
  const api: FakeApi = {
    calls: [],
    reply(prefix, data) {
      overrides.unshift([prefix, data]);
    },
    get(url) {
      api.calls.push(['get', url]);
      return Promise.resolve({ data: pick(url) });
    },
    post(url) {
      api.calls.push(['post', url]);
      return Promise.resolve({ data: pick(url) });
    },
    put(url) {
      api.calls.push(['put', url]);
      return Promise.resolve({ data: pick(url) });
    },
    delete(url) {
      api.calls.push(['delete', url]);
      return Promise.resolve({ data: pick(url) });
    },
  };
  return api;
};

// ---------------------------------------------------------------------------
// Заготовки данных
// ---------------------------------------------------------------------------

let nextId = 100;

export const message = (over: Partial<Record<string, any>> = {}) => ({
  id: (nextId += 1),
  chat_id: 'general',
  sender_id: 2,
  sender_name: 'Борис',
  text: 'привет',
  timestamp: Date.now(),
  status: 'sent',
  ...over,
});
