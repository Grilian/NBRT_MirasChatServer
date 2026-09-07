import { render } from '@testing-library/react';
import Avatar from './Avatar';

// Счётчик непрочитанного на аватаре — «обязательное решение» концепции, и у
// него есть требования, которые легко потерять при следующей правке разметки.

describe('Avatar: счётчик непрочитанного', () => {
  test('показывается числом, когда есть что читать', () => {
    const { container } = render(<Avatar name="Борис Сотрудник" unread={7} />);
    const badge = container.querySelector('.avatar-unread');
    expect(badge).toHaveTextContent('7');
    expect(badge).toHaveAttribute('aria-label', 'Непрочитанных: 7');
  });

  test('на нуле метки нет вовсе — пустой кружок читался бы как «что-то есть»', () => {
    const { container } = render(<Avatar name="Борис" unread={0} />);
    expect(container.querySelector('.avatar-unread')).toBeNull();
  });

  test('без счётчика метка не появляется', () => {
    const { container } = render(<Avatar name="Борис" />);
    expect(container.querySelector('.avatar-unread')).toBeNull();
  });

  test('большие значения сворачиваются в «99+», а не растягивают метку', () => {
    const { container } = render(<Avatar name="Общий чат" unread={1247} />);
    expect(container.querySelector('.avatar-unread')).toHaveTextContent('99+');
  });

  test('99 показывается как есть, 100 — уже свёрнуто', () => {
    const a = render(<Avatar name="A" unread={99} />);
    expect(a.container.querySelector('.avatar-unread')).toHaveTextContent('99');
    const b = render(<Avatar name="B" unread={100} />);
    expect(b.container.querySelector('.avatar-unread')).toHaveTextContent('99+');
  });

  test('счётчик и точка присутствия существуют одновременно', () => {
    // Они разведены по разным углам именно для этого: наложенные друг на
    // друга, они прятали одно из двух состояний.
    const { container } = render(<Avatar name="Борис" online unread={3} />);
    expect(container.querySelector('.avatar-unread')).toBeTruthy();
    expect(container.querySelector('.dot')).toBeTruthy();
  });

  test('метка есть у всех видов аватара, а не только у людей', () => {
    // Общий чат, группа и «Избранное» рисуются значками, а не инициалами —
    // и раньше счётчик им доставался из другого места разметки.
    for (const props of [
      { isGeneral: true },
      { isGroup: true },
      { isSelf: true },
      { isGroup: true, avatarPath: '/uploads/users/1/avatar/g.png' },
    ]) {
      const { container } = render(<Avatar name="Чат" unread={4} {...props} />);
      expect(container.querySelector('.avatar-unread'), JSON.stringify(props)).toHaveTextContent('4');
    }
  });

  test('логотип группы остаётся картинкой внутри аватара', () => {
    // Прозрачные PNG-логотипы не обрезаются в круг: правило про силуэт живёт
    // на самой картинке, а обёртка нужна счётчику как точка отсчёта.
    const { container } = render(
      <Avatar name="Группа" isGroup avatarPath="/uploads/users/1/avatar/logo.png" unread={2} />,
    );
    expect(container.querySelector('.avatar.avatar-photo')).toBeTruthy();
    expect(container.querySelector('img.avatar-photo-img')).toBeTruthy();
    expect(container.querySelector('.avatar-unread')).toHaveTextContent('2');
  });
});
