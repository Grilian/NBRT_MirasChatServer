import type { Mock } from 'vitest';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import api from '@/shared/api/client';
import ThreadPanel from './ThreadPanel';

vi.mock('@/shared/api/client', () => ({
  __esModule: true,
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('@/features/chats/ChatWindow', () => ({ default: () => <div data-testid="thread-messages" /> }));
vi.mock('@/features/chats/MessageInput', () => ({ default: () => <div data-testid="thread-input" /> }));
vi.mock('@/features/polls/PollCreator', () => ({ default: () => null }));
vi.mock('@/features/polls/PollCard', () => ({ default: () => null }));
const response = {
  root: {
    id: 10,
    chat_id: 'group_1',
    text: 'Корень',
    sender_id: 1,
    username: 'author',
    created_at: '2026-08-11T10:00:00.000Z',
  },
  replies: [],
  summary: { reply_count: 0, unread_count: 1, last_reply_at: null, recent_authors: [] },
};

const socket = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  timeout: vi.fn(() => ({ emit: vi.fn() })),
} as any;

test('не отмечает ветку прочитанной в фоне и делает это после возврата фокуса', async () => {
  (api.get as Mock).mockResolvedValue({ data: response });
  (api.post as Mock).mockResolvedValue({ data: { ok: true } });

  const props = {
    rootId: 10,
    currentUserId: 2,
    socket,
    customEmoji: {},
    readActive: false,
    onClose: vi.fn(),
    onSummary: vi.fn(),
    onRead: vi.fn(),
    onRequestDelete: vi.fn(),
  };
  const { rerender } = render(<ThreadPanel {...props} />);

  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/messages/threads/10'));
  expect(api.post).not.toHaveBeenCalled();

  rerender(<ThreadPanel {...props} readActive />);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/messages/threads/10/read'));
  expect(api.post).toHaveBeenCalledTimes(1);
});
