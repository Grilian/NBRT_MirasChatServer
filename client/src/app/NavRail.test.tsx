import { render } from '@testing-library/react';
import NavRail, {
  SECTIONS, mobilePinnedFor, mobileOverflowFor, mobileSectionsFor, isSectionAllowedFor,
} from './NavRail';

// Разделов восемь, слотов в нижней панели пять. Как именно они делятся — не
// вкусовщина: прежний набор из пяти закреплённых ПРЯТАЛ «Календарь» и «Файлы»
// так, что попасть в них можно было только плитками с «Главной».

describe('раскладка разделов по нижней панели', () => {
  test('закреплённых ровно четыре — пятый слот занимает «Ещё»', () => {
    // Порядок — из SECTIONS, а не из списка закреплённых: панель и рельс
    // обязаны идти одинаково, иначе смахивание уводит не к соседу.
    expect(mobilePinnedFor('staff')).toEqual(['home', 'chats', 'calendar', 'tasks']);
  });

  test('за «Ещё» лежит ВСЁ остальное, ничего не теряется', () => {
    const pinned = mobilePinnedFor('staff');
    const overflow = mobileOverflowFor('staff');
    const all = SECTIONS.map((s) => s.id);

    expect([...pinned, ...overflow].sort()).toEqual([...all].sort());
    // Пересечения быть не может: раздел либо закреплён, либо за «Ещё».
    expect(pinned.filter((id) => overflow.includes(id))).toEqual([]);
  });

  test('порядок берётся из SECTIONS, а не из своего списка', () => {
    // Два независимых перечня одного и того же уже приводили к тому, что
    // жест смахивания уводил не к соседу, а «куда-то».
    const order = SECTIONS.map((s) => s.id);
    const overflow = mobileOverflowFor('staff');
    const positions = overflow.map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('аккаунту «Интернет» недоступные разделы не попадают ни в панель, ни в «Ещё»', () => {
    for (const id of [...mobilePinnedFor('internet'), ...mobileOverflowFor('internet')]) {
      expect(isSectionAllowedFor('internet', id), id).toBe(true);
    }
    expect(mobileOverflowFor('internet')).not.toContain('spaces');
  });

  test('перелистывание смахиванием ходит по закреплённым', () => {
    // Смахивать на раздел, которого нет в панели, значит уводить человека
    // туда, откуда он не поймёт, как вернуться жестом.
    expect(mobileSectionsFor('staff')).toEqual(mobilePinnedFor('staff'));
  });
});

describe('рельс', () => {
  const base = {
    active: 'chats' as const,
    onSelect: () => {},
    unreadTotal: 0,
    accountType: 'staff',
  };

  test('«Ещё» появляется только когда его дали — на десктопе кнопки нет', () => {
    const desktop = render(<NavRail {...base} />);
    expect(desktop.container.querySelector('.rail-item-more')).toBeNull();

    const mobile = render(<NavRail {...base} onOpenMore={() => {}} />);
    expect(mobile.container.querySelector('.rail-item-more')).toBeTruthy();
  });

  test('«Ещё» подсвечено, пока открыт спрятанный за ним раздел', () => {
    // Иначе человек в «Файлах» видит панель без единого активного пункта и не
    // понимает, где находится.
    const { container } = render(
      <NavRail {...base} active="documents" onOpenMore={() => {}} moreActive />,
    );
    expect(container.querySelector('.rail-item-more')).toHaveClass('is-active');
  });

  test('подписи включает раскладка, а не медиазапрос', () => {
    // Подписи — первая уступка при сужении окна. Условие обязано приезжать
    // из layoutMode вместе с остальными уступками: второй независимый порог
    // в CSS разошёлся бы с первым, и рельс менял бы вид не там, где считает
    // раскладка.
    const icons = render(<NavRail {...base} />);
    expect(icons.container.querySelector('.nav-rail')).not.toHaveClass('is-expanded');

    const labelled = render(<NavRail {...base} expanded />);
    expect(labelled.container.querySelector('.nav-rail')).toHaveClass('is-expanded');
  });

  test('названия разделов в разметке есть всегда — их прячет только оформление', () => {
    // Подпись не выкидывается из DOM в узком рельсе: она остаётся именем
    // кнопки для экранных читалок, а спрятана визуально.
    const { container } = render(<NavRail {...base} />);
    const labels = [...container.querySelectorAll('.rail-label')].map((n) => n.textContent);
    expect(labels).toContain('Пространства');
    expect(labels).toContain('Настройки');
  });

  test('заголовок группы «Работа» стоит перед «Пространствами»', () => {
    const { container } = render(<NavRail {...base} />);
    const head = container.querySelector('.rail-group');
    expect(head).toHaveTextContent('Работа');
    expect(head!.nextElementSibling).toHaveClass('rail-item-spaces');
  });
});
