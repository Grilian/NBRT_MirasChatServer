import React from 'react';
import { render, waitFor } from '@testing-library/react';
import api from '../api/client';
import ThreadPanel from './ThreadPanel';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('./ChatWindow', () => () => <div data-testid="thread-messages" />);
jest.mock('./MessageInput', () => () => <div data-testid="thread-input" />);
jest.mock('./PollCreator', () => () => null);
jest.mock('./PollCard', () => () => null);

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
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  timeout: jest.fn(() => ({ emit: jest.fn() })),
} as any;

test('не отмечает ветку прочитанной в фоне и делает это после возврата фокуса', async () => {
  (api.get as jest.Mock).mockResolvedValue({ data: response });
  (api.post as jest.Mock).mockResolvedValue({ data: { ok: true } });

  const props = {
    rootId: 10,
    currentUserId: 2,
    socket,
    customEmoji: {},
    readActive: false,
    onClose: jest.fn(),
    onSummary: jest.fn(),
    onRead: jest.fn(),
    onRequestDelete: jest.fn(),
  };
  const { rerender } = render(<ThreadPanel {...props} />);

  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/messages/threads/10'));
  expect(api.post).not.toHaveBeenCalled();

  rerender(<ThreadPanel {...props} readActive />);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/messages/threads/10/read'));
  expect(api.post).toHaveBeenCalledTimes(1);
});
