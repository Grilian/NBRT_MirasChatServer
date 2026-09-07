import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import UserInfoModal from './UserInfoModal';

const user = { id: 2, username: 'tester', display_name: 'Тестировщик' };

test('notification action calls the real handler without a development label', async () => {
  const onToggleNotifications = vi.fn().mockResolvedValue(undefined);
  render(
    <UserInfoModal
      user={user}
      notificationsMuted={false}
      onToggleNotifications={onToggleNotifications}
      currentUserId={1}
      onClose={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Отключить уведомления' }));
  await waitFor(() => expect(onToggleNotifications).toHaveBeenCalledWith(true));
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('Уведомления отключены');
  expect(status).not.toHaveTextContent('в разработке');
});

test('в ряду действий остались только настоящие', () => {
  // Их было четыре, и три отвечали «— в разработке»: звонок, поиск по
  // переписке и «Ещё». Ряд, где работает одна кнопка из четырёх, стоит
  // человеку трёх попыток, прежде чем он поймёт, что нажимать нечего.
  render(<UserInfoModal user={user} currentUserId={1} onClose={vi.fn()} onWrite={vi.fn()} />);

  expect(screen.getByRole('button', { name: 'Написать' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Отключить уведомления' })).toBeInTheDocument();
  for (const gone of ['Звонок', 'Поиск по переписке', 'Ещё']) {
    expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
  }
});

test('«Написать» открывает переписку, а не показывает заглушку', () => {
  // Действие, ради которого на профиль и заходят: раньше его не было вовсе.
  const onWrite = vi.fn();
  render(<UserInfoModal user={user} currentUserId={1} onClose={vi.fn()} onWrite={onWrite} />);

  fireEvent.click(screen.getByRole('button', { name: 'Написать' }));
  expect(onWrite).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('без обработчика кнопки «Написать» нет — она не рисуется вхолостую', () => {
  render(<UserInfoModal user={user} currentUserId={1} onClose={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Написать' })).not.toBeInTheDocument();
});
