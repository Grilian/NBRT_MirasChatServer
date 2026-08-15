import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../api/client';
import StatusPicker from './StatusPicker';
import { describeStatus, statusExpiryAt } from '../utils/statusMeta';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { put: jest.fn() },
}));

const put = api.put as jest.Mock;

beforeEach(() => put.mockReset());

test('sets a preset status through the server and updates the UI state', async () => {
  put.mockResolvedValue({ data: { status_preset: 'vacation', status_custom: null } });
  const onStatusChanged = jest.fn();
  render(
    <StatusPicker
      statusPreset={null}
      statusCustom={null}
      onStatusChanged={onStatusChanged}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /В отпуске/ }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/users/me/status', expect.objectContaining({
    status_preset: 'vacation',
    status_custom: null,
  })));
  expect(onStatusChanged).toHaveBeenCalledWith('vacation', null);
});

test('removes an active status through the server', async () => {
  put.mockResolvedValue({ data: { status_preset: null, status_custom: null } });
  const onStatusChanged = jest.fn();
  render(
    <StatusPicker
      statusPreset="vacation"
      statusCustom={null}
      onStatusChanged={onStatusChanged}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Убрать статус' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/users/me/status', {
    status_preset: null,
    status_custom: null,
    status_expires_at: null,
  }));
  expect(onStatusChanged).toHaveBeenCalledWith(null, null);
});

describe('срок статуса', () => {
  test('конкретное время в будущем — сегодня, в прошлом — завтра', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    jest.useFakeTimers().setSystemTime(now);

    const later = statusExpiryAt('18:30')!;
    expect(new Date(later).getDate()).toBe(now.getDate());
    expect(new Date(later).getHours()).toBe(18);

    // «до 9:00», выставленное в полдень, — это завтрашнее утро, а не мгновенное
    // снятие статуса.
    const earlier = statusExpiryAt('09:00')!;
    expect(earlier).toBeGreaterThan(now.getTime());
    expect(new Date(earlier).getDate()).toBe(now.getDate() + 1);

    expect(statusExpiryAt('99:99')).toBeNull();
    expect(statusExpiryAt('')).toBeNull();
    jest.useRealTimers();
  });

  test('свой эмодзи в начале статуса становится значком, а не частью подписи', () => {
    expect(describeStatus(null, '🚗 в дороге')).toEqual({ emoji: '🚗', label: 'в дороге' });
    // Без эмодзи остаётся прежний значок-заглушка.
    expect(describeStatus(null, 'просто текст')).toEqual({ emoji: '💬', label: 'просто текст' });
    // Один эмодзи без текста — это ещё не подпись, значок остаётся общим.
    expect(describeStatus(null, '🚗')).toEqual({ emoji: '💬', label: '🚗' });
  });
});
