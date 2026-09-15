import { captureScrollAnchor, didAppendNewestMessage, restoreScrollAnchor } from './scrollAnchor';

const rect = (top: number, bottom: number) => ({
  top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top,
  toJSON: () => ({}),
} as DOMRect);

test('keeps the same visible message in place after history is prepended', () => {
  const container = document.createElement('div');
  const first = document.createElement('div');
  const anchor = document.createElement('div');
  first.dataset.msgId = '10';
  anchor.dataset.msgId = '11';
  container.append(first, anchor);
  container.getBoundingClientRect = () => rect(100, 500);
  first.getBoundingClientRect = () => rect(40, 90);
  anchor.getBoundingClientRect = () => rect(110, 160);
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 600 });
  container.scrollTop = 20;

  const snapshot = captureScrollAnchor(container);
  const older = document.createElement('div');
  older.dataset.msgId = '9';
  older.getBoundingClientRect = () => rect(-40, 10);
  container.prepend(older);
  anchor.getBoundingClientRect = () => rect(310, 360);
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 800 });

  expect(restoreScrollAnchor(container, snapshot)).toBe(true);
  expect(container.scrollTop).toBe(220);
});

test('оставляет человека там, куда он долистал, пока ехала страница', () => {
  // Инерционный бросок на телефоне продолжается всё время ожидания ответа.
  // Прежняя версия возвращала якорное сообщение в положение НА МОМЕНТ ЗАПРОСА
  // и отматывала весь этот путь назад — это и выглядело как скачок ленты.
  const container = document.createElement('div');
  const first = document.createElement('div');
  first.dataset.msgId = '10';
  container.append(first);
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 600 });
  container.scrollTop = 20;

  const snapshot = captureScrollAnchor(container);

  // Пока ответ едет, человек листает дальше. Высота при этом не меняется, и
  // снимок, обновляемый на каждом событии прокрутки, остаётся верным.
  container.scrollTop = 300;

  const older = document.createElement('div');
  older.dataset.msgId = '9';
  container.prepend(older);
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 800 });

  expect(restoreScrollAnchor(container, snapshot)).toBe(true);
  expect(container.scrollTop).toBe(500);
});

test('does not consume the history anchor when content only grows at the bottom', () => {
  const container = document.createElement('div');
  const message = document.createElement('div');
  message.dataset.msgId = '10';
  message.getBoundingClientRect = () => rect(110, 160);
  container.getBoundingClientRect = () => rect(100, 500);
  container.append(message);
  const snapshot = captureScrollAnchor(container);

  const incoming = document.createElement('div');
  incoming.dataset.msgId = '11';
  container.append(incoming);

  expect(restoreScrollAnchor(container, snapshot)).toBe(false);
});

test('distinguishes prepended history from a newly appended message', () => {
  expect(didAppendNewestMessage(2, 4, 20, 20, false)).toBe(false);
  expect(didAppendNewestMessage(2, 3, 20, 21, false)).toBe(true);
  expect(didAppendNewestMessage(0, 3, null, 21, true)).toBe(false);
});
