import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import api from '../api/client';
import StickerPicker, { invalidateStickerPackCache } from './StickerPicker';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const mockedGet = api.get as jest.Mock;

beforeEach(() => {
  invalidateStickerPackCache();
  mockedGet.mockReset();
});

test('показывает паки вкладками с обложками и не смешивает их стикеры', async () => {
  mockedGet.mockResolvedValue({
    data: [
      {
        id: 1,
        name: 'Чернильцы',
        cover_path: '/uploads/stickers/ink-cover.webp',
        items: [{ id: 11, file_path: '/uploads/stickers/ink.webp', animated_path: null, emoji: '🙂' }],
      },
      {
        id: 2,
        name: 'Коты',
        cover_path: '/uploads/stickers/cat-cover.webp',
        items: [{ id: 22, file_path: '/uploads/stickers/cat.webp', animated_path: null, emoji: '🐈' }],
      },
    ],
  });

  const { getByRole, queryByRole } = render(<StickerPicker onPick={() => {}} />);

  const inkTab = await waitFor(() => getByRole('tab', { name: 'Чернильцы' }));
  const catTab = getByRole('tab', { name: 'Коты' });
  expect(inkTab.querySelector('img')).toHaveAttribute('src', expect.stringContaining('ink-cover.webp'));
  expect(catTab.querySelector('img')).toHaveAttribute('src', expect.stringContaining('cat-cover.webp'));
  expect(getByRole('button', { name: '🙂' })).toBeInTheDocument();
  expect(queryByRole('button', { name: '🐈' })).not.toBeInTheDocument();

  fireEvent.click(catTab);
  expect(getByRole('button', { name: '🐈' })).toBeInTheDocument();
  expect(queryByRole('button', { name: '🙂' })).not.toBeInTheDocument();
});
