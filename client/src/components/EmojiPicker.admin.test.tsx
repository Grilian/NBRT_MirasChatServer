import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import EmojiPicker from './EmojiPicker';

test('admin reaction picker uses uploaded packs and keeps multi-selection open', () => {
  const onPick = jest.fn();
  const { getByRole } = render(
    <EmojiPicker
      embedded
      packsOverride={[{
        id: 1,
        name: 'Чернильцы',
        emoji: [],
        custom: [{ id: 10, name: 'ink_happy', file_path: '/uploads/emoji/ink_happy.webp', fallback: '🙂' }],
      }]}
      selectedCustomEmoji={[':ink_happy:']}
      onPick={onPick}
      onClose={() => {}}
    />,
  );

  const emoji = getByRole('button', { name: ':ink_happy:' });
  expect(emoji).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(emoji);
  expect(onPick).toHaveBeenCalledWith({
    name: 'ink_happy',
    filePath: '/uploads/emoji/ink_happy.webp',
    fallback: '🙂',
  });
  expect(emoji).toBeInTheDocument();
});
