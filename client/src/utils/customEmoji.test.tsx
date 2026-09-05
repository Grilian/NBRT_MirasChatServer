import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { buildEmojiMap, getEmojiSuggestions, renderMessageText, toPlainText } from './customEmoji';

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

  test('рендерит обычный Unicode через активный набор, не меняя текст сообщения', () => {
    const map = buildEmojiMap([{
      name: 'u_1f600', file_path: '/uploads/emoji/apple_1f600.webp',
      animated_path: '/uploads/emoji/telegram_1f600.webp', fallback: '😀',
      unicode_key: '1f600', label: 'grinning face', keywords: 'улыбка радость',
    }]);
    const { container } = render(<div>{renderMessageText('Привет 😀!', map)}</div>);

    expect(container.querySelector('img.custom-emoji')).toHaveAttribute('alt', '😀');
    expect(getEmojiSuggestions(map, 'улыб', 3)[0]?.token).toBe('😀');
  });

  test('составная Unicode-последовательность выбирается целиком', () => {
    const map = buildEmojiMap([{
      name: 'u_1f1e6_1f1e8', file_path: '/uploads/emoji/flag.webp', fallback: '🇦🇨',
      unicode_key: '1f1e6-1f1e8', label: 'flag',
    }]);
    const { container } = render(<div>{renderMessageText('Флаг 🇦🇨 здесь', map)}</div>);

    expect(container.querySelectorAll('img.custom-emoji')).toHaveLength(1);
    expect(container.querySelector('img.custom-emoji')).toHaveAttribute('alt', '🇦🇨');
  });

  // На слабой связи анимированный webp приезжает заметно позже текста. Пока он
  // в пути, место держит базовый эмодзи — иначе в предложении зияла бы дыра.
  test('пока картинка смайлика не пришла, на её месте базовый эмодзи', () => {
    const map = { cat: { filePath: '/uploads/emoji/cat_ab12.webp', fallback: '🐱' } };
    const { container } = render(<div>{renderMessageText('Привет :cat:', map)}</div>);

    const image = container.querySelector('img.custom-emoji');
    expect(image).toHaveClass('is-loading');
    expect(container.querySelector('.custom-emoji-fallback.is-placeholder')).toHaveTextContent('🐱');

    // Картинка приехала — заглушка уходит, остаётся только она.
    fireEvent.load(image!);
    expect(container.querySelector('.custom-emoji-fallback')).not.toBeInTheDocument();
    expect(container.querySelector('img.custom-emoji')).not.toHaveClass('is-loading');
  });

  test('пропавший файл заменяется базовым эмодзи, а не битой картинкой', () => {
    const map = { dog: { filePath: '/uploads/emoji/dog_cd34.webp', fallback: '🐶' } };
    const { container } = render(<div>{renderMessageText(':dog:', map)}</div>);

    fireEvent.error(container.querySelector('img.custom-emoji')!);
    expect(container.querySelector('img.custom-emoji')).not.toBeInTheDocument();
    expect(container.querySelector('.custom-emoji-fallback')).toHaveTextContent('🐶');
  });
});

// Явный выбор пака при отправке (см. попап выбора «Apple/Google Fonts» в
// композере): сообщение по-прежнему хранит короткий код в тексте, но теперь
// это не user-defined :name:, а машинный e~<unicode_key>~<packKey> — тот же
// плоский механизм подстановки, что и для обычных кастомных смайликов.
describe('выбор конкретного пака оформления (e~<unicode_key>~<packKey>)', () => {
  const items = [{
    name: 'u_1f973', file_path: '/uploads/emoji/apple_1f973.webp', fallback: '🥳',
    unicode_key: '1f973', label: 'partying face',
    variants: [
      { packKey: 'apple', packName: 'Apple', role: 'base' as const, filePath: '/uploads/emoji/apple_1f973.webp' },
      { packKey: 'google-fonts', packName: 'Google Fonts', role: 'base' as const, filePath: '/uploads/emoji/google_1f973.webp' },
    ],
  }];

  test('составной код рендерится именно выбранной картинкой пака, а не активной по умолчанию', () => {
    const map = buildEmojiMap(items);
    const { container } = render(<div>{renderMessageText(':e~1f973~google-fonts:', map)}</div>);

    const image = container.querySelector('img.custom-emoji');
    expect(image).toHaveAttribute('src', expect.stringContaining('google_1f973.webp'));
    expect(image).toHaveAttribute('alt', '🥳');
  });

  test('без явного выбора (обычный Unicode) используется активный по умолчанию набор', () => {
    const map = buildEmojiMap(items);
    const { container } = render(<div>{renderMessageText('Привет 🥳', map)}</div>);

    expect(container.querySelector('img.custom-emoji')).toHaveAttribute(
      'src', expect.stringContaining('apple_1f973.webp'),
    );
  });

  test('если выбранный пак с тех пор пропал, показывается актуальное оформление по умолчанию, а не текст кода', () => {
    const map = buildEmojiMap(items); // варианта 'telegram-legacy' в каталоге уже нет
    const { container } = render(<div>{renderMessageText(':e~1f973~telegram-legacy:', map)}</div>);

    expect(screen.queryByText(':e~1f973~telegram-legacy:')).not.toBeInTheDocument();
    expect(container.querySelector('img.custom-emoji')).toHaveAttribute(
      'src', expect.stringContaining('apple_1f973.webp'),
    );
  });

  test('toPlainText тоже откатывается на символ, а не оставляет технический код', () => {
    const map = buildEmojiMap(items);
    expect(toPlainText(':e~1f973~google-fonts:', map)).toBe('🥳');
    expect(toPlainText(':e~1f973~does-not-exist:', map)).toBe('🥳');
  });

  test('совсем неизвестный unicode_key в составном коде остаётся текстом как есть', () => {
    const map = buildEmojiMap(items);
    expect(toPlainText(':e~ffffff~apple:', map)).toBe(':e~ffffff~apple:');
  });
});
