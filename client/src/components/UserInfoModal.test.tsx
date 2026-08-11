import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import UserInfoModal from './UserInfoModal';

const user = { id: 2, username: 'tester', display_name: 'Тестировщик' };

test('notification action calls the real handler without a development label', async () => {
  const onToggleNotifications = jest.fn().mockResolvedValue(undefined);
  render(
    <UserInfoModal
      user={user}
      notificationsMuted={false}
      onToggleNotifications={onToggleNotifications}
      onClose={jest.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Отключить уведомления' }));
  await waitFor(() => expect(onToggleNotifications).toHaveBeenCalledWith(true));
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('Уведомления отключены');
  expect(status).not.toHaveTextContent('в разработке');
});

test('unfinished profile actions still keep their development label', () => {
  render(<UserInfoModal user={user} onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Звонок' }));
  expect(screen.getByRole('status')).toHaveTextContent('Звонок — в разработке');
});
