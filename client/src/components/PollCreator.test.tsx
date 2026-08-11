import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import PollCreator from './PollCreator';

test('creates a valid poll with participant-added options enabled', () => {
  const onCreate = jest.fn();
  render(<PollCreator onClose={jest.fn()} onCreate={onCreate} />);

  const create = screen.getByRole('button', { name: 'Создать' });
  expect(create).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText('Текст вопроса'), { target: { value: 'Куда поедем?' } });
  fireEvent.change(screen.getByPlaceholderText('Ответ 1'), { target: { value: 'Москва' } });
  fireEvent.change(screen.getByPlaceholderText('Ответ 2'), { target: { value: 'Казань' } });
  fireEvent.click(screen.getByText('Добавление вариантов'));
  expect(create).toBeEnabled();
  fireEvent.click(create);

  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    question: 'Куда поедем?',
    options: ['Москва', 'Казань'],
    allowAddOptions: true,
    showVoterNames: true,
    allowChangeVote: true,
  }));
});

test('does not allow duplicate options ignoring Russian letter case', () => {
  render(<PollCreator onClose={jest.fn()} onCreate={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('Текст вопроса'), { target: { value: 'Вопрос' } });
  fireEvent.change(screen.getByPlaceholderText('Ответ 1'), { target: { value: 'Москва' } });
  fireEvent.change(screen.getByPlaceholderText('Ответ 2'), { target: { value: 'МОСКВА' } });
  expect(screen.getByText('Варианты ответа не должны повторяться.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Создать' })).toBeDisabled();
});

test('closes only after a completed backdrop click', () => {
  const onClose = jest.fn();
  const { container } = render(<PollCreator onClose={onClose} onCreate={jest.fn()} />);
  const layer = container.querySelector('.poll-creator-layer') as HTMLElement;

  fireEvent.mouseDown(layer);
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('heading', { name: 'Новый опрос' }));
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(layer);
  expect(onClose).toHaveBeenCalledTimes(1);
});
