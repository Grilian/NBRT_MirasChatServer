import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ThreadInbox from './ThreadInbox';
import { ThreadInboxItem } from '../types/thread';

const item: ThreadInboxItem = {
  root_id: 17,
  chat_id: 'group_2',
  chat: { name: 'Рабочая группа', kind: 'group' },
  root: {
    id: 17, sender_id: 1, username: 'anna', display_name: 'Анна', text: 'Корневое сообщение', created_at: '2026-08-11T10:00:00Z',
  },
  last_reply: {
    id: 18, sender_id: 2, username: 'ivan', display_name: 'Иван', text: 'Новый ответ', created_at: '2026-08-11T10:05:00Z',
  },
  summary: { reply_count: 3, unread_count: 2, last_reply_at: '2026-08-11T10:05:00Z', recent_authors: [] },
};

test('shows participating threads and opens the selected discussion', () => {
  const onOpen = jest.fn();
  render(<ThreadInbox items={[item]} loading={false} onBack={() => {}} onOpen={onOpen} />);
  expect(screen.getByText('Рабочая группа')).toBeInTheDocument();
  expect(screen.getByText('Корневое сообщение')).toBeInTheDocument();
  expect(screen.getByText('Новый ответ')).toBeInTheDocument();
  expect(screen.getByText('2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Рабочая группа/ }));
  expect(onOpen).toHaveBeenCalledWith(17);
});

test('shows an explanatory empty state', () => {
  render(<ThreadInbox items={[]} loading={false} onBack={() => {}} onOpen={() => {}} />);
  expect(screen.getByText('У вас пока нет веток')).toBeInTheDocument();
});
