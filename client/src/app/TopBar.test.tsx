import { render, fireEvent } from '@testing-library/react';
import TopBar from './TopBar';
import { SearchTarget } from '@/features/search/globalSearch';

const targets: SearchTarget[] = [
  { chatId: 'general', name: 'Общий чат', kind: 'channel' },
  { chatId: 'chat_1_2', name: 'Борис Сотрудник', kind: 'chat', username: 'bob', userId: 2 },
  { chatId: 'group_3', name: 'Методисты', kind: 'group' },
];

const setup = (over: Partial<React.ComponentProps<typeof TopBar>> = {}) => {
  const onPick = vi.fn();
  const onOpenMenu = vi.fn();
  const view = render(
    <TopBar
      targets={targets}
      onPick={onPick}
      selfName="Алиса"
      onOpenMenu={onOpenMenu}
      {...over}
    />,
  );
  const field = view.container.querySelector('.top-bar-search-field') as HTMLInputElement;
  const type = (value: string) => fireEvent.change(field, { target: { value } });
  const rows = () => [...view.container.querySelectorAll('.top-bar-result')];
  return { ...view, onPick, onOpenMenu, field, type, rows };
};

test('выдача появляется только на непустой запрос', () => {
  // Подсказка на весь справочник — это второй список чатов поверх первого.
  const s = setup();
  fireEvent.focus(s.field);
  expect(s.rows()).toHaveLength(0);

  s.type('о');
  expect(s.rows().length).toBeGreaterThan(0);
});

test('стрелки водят по выдаче, Enter выбирает подсвеченное', () => {
  const s = setup();
  s.type('о');
  // Первой стоит «Общий чат» — совпадение с начала имени. Стрелка вниз
  // переводит подсветку на вторую строку, и Enter обязан взять именно её.
  expect(s.rows()[0]).toHaveTextContent('Общий чат');
  fireEvent.keyDown(s.field, { key: 'ArrowDown' });
  fireEvent.keyDown(s.field, { key: 'Enter' });

  expect(s.onPick).toHaveBeenCalledTimes(1);
  expect(s.onPick.mock.calls[0][0].name).toBe('Борис Сотрудник');
});

test('выбор очищает поле — оно не остаётся с чужим запросом', () => {
  const s = setup();
  s.type('методист');
  fireEvent.click(s.rows()[0]);

  expect(s.onPick).toHaveBeenCalledTimes(1);
  expect(s.field.value).toBe('');
  expect(s.rows()).toHaveLength(0);
});

test('первый Escape убирает выдачу, второй очищает поле', () => {
  // Чаще всего промахнулись строкой, а не запросом: стирать набранное сразу
  // значит заставить набирать заново.
  const s = setup();
  s.type('о');
  expect(s.rows().length).toBeGreaterThan(0);

  fireEvent.keyDown(s.field, { key: 'Escape' });
  expect(s.rows()).toHaveLength(0);
  expect(s.field.value).toBe('о');

  fireEvent.keyDown(s.field, { key: 'Escape' });
  expect(s.field.value).toBe('');
});

test('пустая выдача объясняется словами, а не пустотой', () => {
  // Молчащий поиск неотличим от сломанного, и человек не понимает, ищет ли
  // приложение вообще по тексту сообщений.
  const s = setup();
  s.type('такого нет');
  expect(s.container.querySelector('.top-bar-results-empty')).toHaveTextContent('Ничего не нашлось');
});

test('подпись поля не обещает поиска по сообщениям, пока его нет', () => {
  const s = setup();
  expect(s.field).toHaveAttribute('placeholder', 'Чаты, люди и группы');
});

test('аватар открывает меню приложения', () => {
  // Единственный вход в меню на десктопе: гамбургер с рельса убран.
  const s = setup();
  fireEvent.click(s.container.querySelector('.top-bar-self')!);
  expect(s.onOpenMenu).toHaveBeenCalledTimes(1);
});

test('колокольчика нет — центра уведомлений в приложении не существует', () => {
  // Кнопка, которой нечего открыть, неотличима от сломанной. Появится центр
  // уведомлений — появится и колокольчик, и этот тест сменится на обратный.
  const s = setup();
  expect(s.container.querySelector('[aria-label*="ведомлен"]')).toBeNull();
});
