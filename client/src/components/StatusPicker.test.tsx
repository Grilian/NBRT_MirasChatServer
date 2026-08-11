import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../api/client';
import StatusPicker from './StatusPicker';

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

  fireEvent.click(screen.getByRole('button', { name: 'Убрать' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/users/me/status', {
    status_preset: null,
    status_custom: null,
    status_expires_at: null,
  }));
  expect(onStatusChanged).toHaveBeenCalledWith(null, null);
});
