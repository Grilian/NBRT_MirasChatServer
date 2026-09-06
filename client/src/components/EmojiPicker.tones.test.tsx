import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
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
