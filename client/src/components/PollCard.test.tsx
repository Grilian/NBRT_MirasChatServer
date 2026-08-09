import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import PollCard from './PollCard';
import { Poll } from '../types/poll';

function pollFixture(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 7,
    message_id: 20,
    chat_id: 'general',
    creator_id: 1,
    question: 'Куда поедем?',
    description: null,
    show_voter_names: true,
    multiple_choice: false,
    allow_add_options: true,
    allow_change_vote: true,
    closes_at: null,
    closed_at: null,
    created_at: Date.now(),
    total_voters: 0,
    user_option_ids: [],
    has_voted: false,
    can_add_option: true,
    options: [
      { id: 1, text: 'Москва', position: 0, created_by: 1, vote_count: 0, percentage: 0, is_winner: false, voters: [] },
      { id: 2, text: 'Казань', position: 1, created_by: 1, vote_count: 0, percentage: 0, is_winner: false, voters: [] },
    ],
    ...overrides,
  };
}

test('submits a vote and a participant option', () => {
  const onVote = jest.fn();
  const onAddOption = jest.fn();
  render(<PollCard poll={pollFixture()} onVote={onVote} onAddOption={onAddOption} />);

  fireEvent.click(screen.getByRole('button', { name: /Москва/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Проголосовать' }));
  expect(onVote).toHaveBeenCalledWith(7, [1]);

  const custom = screen.getByLabelText('Добавить свой вариант');
  fireEvent.change(custom, { target: { value: 'Сочи' } });
  fireEvent.keyDown(custom, { key: 'Enter' });
  expect(onAddOption).toHaveBeenCalledWith(7, 'Сочи');
});

test('hides participant input at the 12-option limit and keeps anonymous voters private', () => {
  const options = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    text: `Вариант ${index + 1}`,
    position: index,
    created_by: 1,
    vote_count: index === 0 ? 1 : 0,
    percentage: index === 0 ? 100 : 0,
    is_winner: false,
  }));
  render(<PollCard
    poll={pollFixture({ options, can_add_option: false, show_voter_names: false, has_voted: true, user_option_ids: [1], total_voters: 1 })}
    onVote={jest.fn()}
    onAddOption={jest.fn()}
  />);

  expect(screen.queryByLabelText('Добавить свой вариант')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Посмотреть голоса/ })).not.toBeInTheDocument();
  expect(screen.getByText('1 голос')).toBeInTheDocument();
});
