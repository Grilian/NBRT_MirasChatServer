import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderMessageText } from './customEmoji';

describe('renderMessageText', () => {
  test('makes http and www URLs clickable and keeps sentence punctuation outside', () => {
    render(<div>{renderMessageText('Смотри https://example.com/a и www.example.org/test).', {})}</div>);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/a');
    expect(links[1]).toHaveAttribute('href', 'https://www.example.org/test');
    expect(screen.getByText(').', { exact: false })).toBeInTheDocument();
  });

  test('highlights e-mail without making it clickable', () => {
    const { container } = render(<div>{renderMessageText('Почта: user.name+chat@example.com', {})}</div>);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.querySelector('.message-email')).toHaveTextContent('user.name+chat@example.com');
  });

  test('renders links and custom emoji in the same message', () => {
    const map = { smile: { filePath: '/uploads/smile.webp', fallback: '🙂' } };
    const { container } = render(
      <div>{renderMessageText(':smile: https://example.com', map)}</div>,
    );

    expect(container.querySelector('img.custom-emoji')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
  });
});
