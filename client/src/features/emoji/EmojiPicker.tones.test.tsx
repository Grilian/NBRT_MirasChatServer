import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import EmojiPicker from './EmojiPicker';

// Тона кожи приезжают ВЛОЖЕННО в базовую карточку (сервер схлопывает их в
// выдаче панели выбора). Половина каталога — 1869 элементов из 3770 — это
// именно они, и отдельными карточками раздел «Люди и тело» превращался в
// простыню из 2251 почти одинакового лица.
const packWithTones = [{
  id: 1,
  name: 'Люди и тело',
  emoji: [],
  custom: [{
    id: 10,
    name: 'u_1f44d',
    file_path: '/uploads/emoji/u_1f44d.webp',
    fallback: '👍',
    unicode: '👍',
    unicode_key: '1f44d',
    tones: [
      { unicode_key: '1f44d-1f3fb', unicode: '👍🏻', file_path: '/uploads/emoji/t1.webp', fallback: '👍🏻' },
      { unicode_key: '1f44d-1f3ff', unicode: '👍🏿', file_path: '/uploads/emoji/t5.webp', fallback: '👍🏿' },
    ],
  }],
}];

test('тона не занимают отдельных карточек — в сетке только базовый смайлик', () => {
  render(<EmojiPicker embedded packsOverride={packWithTones} onPick={() => {}} onClose={() => {}} />);
  expect(screen.getAllByRole('button', { name: /:u_1f44d:/ })).toHaveLength(1);
});

test('правый клик открывает выбор тона, а выбранный тон уходит своим символом', () => {
  const picked: any[] = [];
  render(<EmojiPicker embedded packsOverride={packWithTones} onPick={(e) => picked.push(e)} onClose={() => {}} />);

  const cell = screen.getByRole('button', { name: /:u_1f44d:/ });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

  fireEvent.contextMenu(cell);
  const popup = screen.getByRole('listbox', { name: 'Выбор тона кожи' });
  expect(popup).toBeInTheDocument();

  // В сообщение уходит сам тоновый символ, а не базовый и не ссылка на строку
  // каталога: тон — это отдельный Unicode-смайлик, а не оформление.
  fireEvent.click(screen.getByRole('option', { name: '👍🏿' }));
  expect(picked).toHaveLength(1);
  expect(picked[0].token).toBe('👍🏿');
  expect(picked[0].unicodeKey).toBe('1f44d-1f3ff');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('обычный тап по карточке по-прежнему вставляет базовый смайлик', () => {
  const picked: any[] = [];
  render(<EmojiPicker embedded packsOverride={packWithTones} onPick={(e) => picked.push(e)} onClose={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: /:u_1f44d:/ }));
  expect(picked).toHaveLength(1);
  expect(picked[0].token).toBe('👍');
});

// Регрессия 1.11.16: удержание залипало общим на все ячейки флагом, и
// preventDefault на touchend НАВСЕГДА глушил клик по остальным смайликам —
// на телефоне панель просто переставала отзываться. Проверяем не «попап
// открылся», а именно то, что решает судьбу тапа: заглушён ли touchend.
const touch = (el: Element, type: 'touchStart' | 'touchEnd' | 'touchMove', x = 5, y = 5) => {
  const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchEnd' ? [] : [{ clientX: x, clientY: y }],
  });
  Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(event);
  return event;
};

test('после удержания обычные смайлики остаются нажимаемыми', () => {
  vi.useFakeTimers();
  const picked: any[] = [];
  render(
    <EmojiPicker
      embedded
      packsOverride={[{
        id: 1,
        name: 'Смешанный',
        emoji: [],
        custom: [
          packWithTones[0].custom[0],
          { id: 20, name: 'u_1f355', file_path: '/uploads/emoji/p.webp', fallback: '🍕', unicode_key: '1f355' },
        ],
      }]}
      onPick={(e) => picked.push(e)}
      onClose={() => {}}
    />,
  );

  const toned = screen.getByRole('button', { name: /:u_1f44d:/ });
  const plain = screen.getByRole('button', { name: /:u_1f355:/ });

  // Обычный смайлик отзывается до всего.
  expect(touch(plain, 'touchStart') && touch(plain, 'touchEnd').defaultPrevented).toBe(false);

  // Удержание на смайлике с тонами: клик гасится — и это правильно, иначе
  // поверх открытого выбора вставился бы базовый.
  touch(toned, 'touchStart');
  act(() => { vi.advanceTimersByTime(300); });
  expect(touch(toned, 'touchEnd').defaultPrevented).toBe(true);

  // Закрываем выбор. Пока он открыт, первое касание мимо штатно уходит на
  // закрытие и до смайлика под ним не доходит — это общее правило всех
  // всплывающих поверхностей приложения, а не наша поломка.
  act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

  // А вот теперь обычный смайлик обязан отзываться. Именно это ломалось:
  // залипший флаг глушил его навсегда.
  touch(plain, 'touchStart');
  expect(touch(plain, 'touchEnd').defaultPrevented).toBe(false);
  touch(plain, 'touchStart');
  expect(touch(plain, 'touchEnd').defaultPrevented).toBe(false);

  vi.useRealTimers();
});

test('дрожание пальца удержание не отменяет, а настоящая прокрутка — отменяет', () => {
  vi.useFakeTimers();
  render(<EmojiPicker embedded packsOverride={packWithTones} onPick={() => {}} onClose={() => {}} />);
  const cell = screen.getByRole('button', { name: /:u_1f44d:/ });

  // 3 px — это Android шлёт touchmove от неподвижного пальца. Раньше любое
  // движение отменяло жест, и удержание не срабатывало вовсе.
  touch(cell, 'touchStart', 5, 5);
  touch(cell, 'touchMove', 8, 7);
  act(() => { vi.advanceTimersByTime(300); });
  expect(touch(cell, 'touchEnd').defaultPrevented).toBe(true);
  act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });

  // 40 px — это уже прокрутка сетки: жест отменяется, тап проходит как обычно.
  touch(cell, 'touchStart', 5, 5);
  touch(cell, 'touchMove', 5, 45);
  act(() => { vi.advanceTimersByTime(300); });
  expect(touch(cell, 'touchEnd').defaultPrevented).toBe(false);

  vi.useRealTimers();
});

test('у смайлика без тонов выбора не появляется вовсе', () => {
  render(
    <EmojiPicker
      embedded
      packsOverride={[{
        id: 1,
        name: 'Еда',
        emoji: [],
        custom: [{ id: 20, name: 'u_1f355', file_path: '/uploads/emoji/p.webp', fallback: '🍕', unicode_key: '1f355' }],
      }]}
      onPick={() => {}}
      onClose={() => {}}
    />,
  );

  fireEvent.contextMenu(screen.getByRole('button', { name: /:u_1f355:/ }));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
