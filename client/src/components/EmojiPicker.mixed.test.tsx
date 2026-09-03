import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import EmojiPicker from './EmojiPicker';

// Реальный баг: юникодный элемент новой каталожной системы хранит '' в поле
// emoji (сам символ лежит в fallback/unicode), а панель раньше показывала
// текстовый резерв пака только если в нём НЕТ ни одной картинки — «всё или
// ничего» на уровне пака. Стоило синхронизироваться хотя бы одной картинке
// (например, Apple), как все остальные элементы того же пака — с ещё не
// загруженным оформлением — пропадали целиком: ни картинкой, ни текстом.
test('элемент без картинки виден рядом с элементами, у которых картинка уже есть', () => {
  render(
    <EmojiPicker
      embedded
      packsOverride={[{
        id: 1,
        name: 'Смешанный пак',
        // 😬 — юникодный элемент без синхронизированной картинки. Ничего не
        // дублирует, поэтому должен остаться виден как обычный текстовый смайлик.
        emoji: ['😬'],
        custom: [{ id: 10, name: 'u_1f600', file_path: '/uploads/emoji/u_1f600.webp', fallback: '😀', unicode_key: '1f600' }],
      }]}
      onPick={() => {}}
      onClose={() => {}}
    />,
  );

  expect(screen.getByRole('button', { name: ':u_1f600:' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '😬' })).toBeInTheDocument();
});

// А вот если текстовый символ ДУБЛИРУЕТ уже показанную картинку (тот же
// смайлик и как fallback картинки, и как отдельная запись в emoji — так
// собирает пикер реакций/статуса поверх системного списка), второй раз его
// показывать не нужно. Разница с прошлым тестом ровно в этом совпадении.
test('текстовый дубль уже показанной картинки скрыт, а не показан второй раз', () => {
  render(
    <EmojiPicker
      embedded
      packsOverride={[{
        id: 1,
        name: 'Пак с дублем',
        emoji: ['😊'],
        custom: [{ id: 7, name: 'ink_smile', file_path: '/uploads/emoji/ink_smile.webp', fallback: '😊' }],
      }]}
      onPick={() => {}}
      onClose={() => {}}
    />,
  );

  expect(document.querySelectorAll('.emoji-cell')).toHaveLength(1);
  expect(screen.getByRole('button', { name: ':ink_smile:' })).toBeInTheDocument();
});

test('обложка вкладки пака предпочитает загруженную картинку символу', () => {
  const { container } = render(
    <EmojiPicker
      embedded
      packsOverride={[
        {
          id: 1,
          name: 'Пак с картинкой',
          emoji: ['😀'],
          custom: [{ id: 1, name: 'u_1f600', file_path: '/uploads/emoji/u_1f600.webp', fallback: '😀' }],
        },
        { id: 2, name: 'Пак без картинок', emoji: ['🙂'], custom: [] },
      ]}
      onPick={() => {}}
      onClose={() => {}}
    />,
  );

  const tabs = container.querySelectorAll('.emoji-tab-icon');
  expect(tabs[0].querySelector('img')).not.toBeNull();
  expect(tabs[1].textContent).toBe('🙂');
});
