import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../api/client';
import StatusPicker from './StatusPicker';
import { describeStatus, statusExpiryOn } from '../utils/statusMeta';

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
  expect(put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Установить' }));
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

  fireEvent.click(screen.getByRole('button', { name: 'Снять статус' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/users/me/status', {
    status_preset: null,
    status_custom: null,
    status_expires_at: null,
  }));
  expect(onStatusChanged).toHaveBeenCalledWith(null, null);
});

describe('срок статуса', () => {
  test('дата со временем принимается, прошедший момент — нет', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    jest.useFakeTimers().setSystemTime(now);

    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const later = statusExpiryOn(`${iso(now)}T18:30`)!;
    expect(new Date(later).getHours()).toBe(18);
    expect(new Date(later).getDate()).toBe(now.getDate());

    // Дата задаётся вручную — можно уехать хоть на неделю вперёд.
    const nextWeek = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const far = statusExpiryOn(`${iso(nextWeek)}T09:00`)!;
    expect(new Date(far).getDate()).toBe(nextWeek.getDate());

    // Прошедший момент снял бы статус мгновенно — такой не принимаем.
    expect(statusExpiryOn(`${iso(now)}T09:00`)).toBeNull();
    expect(statusExpiryOn('мусор')).toBeNull();
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

