import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SettingsPanel from './SettingsPanel';
import { runTopBackInterceptor } from '@/shared/hooks/backInterceptors';

// Настройки перестали быть одним свитком: слева оглавление, справа один
// раздел. Здесь закреплено то, что легко потерять при следующей правке.

vi.mock('@/shared/api/client', () => ({
  __esModule: true,
  default: { get: vi.fn(() => Promise.resolve({ data: {} })), put: vi.fn(), post: vi.fn() },
}));
vi.mock('@/shared/platform/mobileNotify', () => ({
  isNativeMobile: false,
  ensureMobileNotificationPermission: vi.fn(),
}));

const baseProps = {
  username: 'Алиса',
  avatarPath: null,
  onClose: vi.fn(),
  onOpenProfile: vi.fn(),
  onDeleteAccount: vi.fn(),
  onLogout: vi.fn(),
};

const nav = (name: string) => screen.getByRole('button', { name });

afterEach(() => { delete (window as { electronAPI?: unknown }).electronAPI; });

test('открыт один раздел, а не весь свиток сразу', () => {
  // Ради этого всё и делалось: чтобы добраться до темы, не нужно пролистывать
  // уведомления и настройки приложения.
  render(<SettingsPanel {...baseProps} />);

  expect(screen.getByText('Тема')).toBeInTheDocument();
  expect(screen.queryByText('Уведомления о сообщениях')).not.toBeInTheDocument();
});

test('переключение раздела меняет содержимое и подсветку', () => {
  const { container } = render(<SettingsPanel {...baseProps} />);

  fireEvent.click(nav('Уведомления'));

  expect(screen.getByText('Уведомления о сообщениях')).toBeInTheDocument();
  expect(screen.queryByText('Тема')).not.toBeInTheDocument();
  expect(container.querySelector('.settings-nav-item.is-active')).toHaveTextContent('Уведомления');
});

test('«Подключение» есть только в десктопном клиенте', () => {
  // Сетью вне Electron распоряжается не приложение, и пункт, за которым пусто,
  // неотличим от сломанного.
  render(<SettingsPanel {...baseProps} />);
  expect(screen.queryByRole('button', { name: 'Подключение' })).not.toBeInTheDocument();
});

test('аппаратный «Назад» возвращает к оглавлению, а не выходит из настроек', () => {
  // Раздел на узком экране — отдельный уровень, и выход из него мимо
  // оглавления читался бы как проскок.
  render(<SettingsPanel {...baseProps} />);
  fireEvent.click(nav('Аккаунт'));
  expect(screen.getByText('Выйти')).toBeInTheDocument();

  // act — перехватчик меняет состояние React мимо события, и без обёртки
  // разметка остаётся прежней: проверялся бы не результат, а его отсутствие.
  let handled = false;
  act(() => { handled = runTopBackInterceptor(); });
  expect(handled).toBe(true);
  expect(screen.queryByText('Выйти')).not.toBeInTheDocument();

  // Оглавление открыто — перехватывать больше нечего, и следующий «Назад»
  // обязан достаться самому приложению.
  expect(runTopBackInterceptor()).toBe(false);
});

test('на оглавлении перехватчика нет вовсе', () => {
  render(<SettingsPanel {...baseProps} />);
  expect(runTopBackInterceptor()).toBe(false);
});
