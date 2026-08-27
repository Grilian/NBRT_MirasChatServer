import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import WebDownloadLinks from './WebDownloadLinks';

const response = (body: string | object) => Promise.resolve({
  ok: true,
  text: () => Promise.resolve(String(body)),
  json: () => Promise.resolve(body),
} as Response);

beforeEach(() => {
  (global as any).fetch = jest.fn((input: string | URL) => {
    const url = String(input);
    if (url.endsWith('latest.yml')) return response('version: 1.2.3\npath: MirasChat Setup 1.2.3.exe\n');
    if (url.endsWith('android.json')) return response({ url: '/miraschat/updates/MirasChat-1.2.3.apk' });
    if (url.endsWith('linux.json')) return response({ url: '/miraschat/updates/MirasChat-1.2.3.deb' });
    return Promise.reject(new Error(`unexpected URL ${url}`));
  });
});

afterEach(() => { jest.restoreAllMocks(); });

test('в веб-настройках показывает все три дистрибутива и установку на iPhone', async () => {
  render(<WebDownloadLinks variant="settings" />);

  await waitFor(() => expect(screen.getByRole('link', { name: /Windows/ })).toHaveAttribute(
    'href', expect.stringContaining('MirasChat%20Setup%201.2.3.exe'),
  ));
  expect(screen.getByRole('link', { name: /Android/ })).toHaveAttribute('href', expect.stringContaining('.apk'));
  expect(screen.getByRole('link', { name: /Linux/ })).toHaveAttribute('href', expect.stringContaining('.deb'));

  fireEvent.click(screen.getByRole('button', { name: /iPhone/ }));
  const guide = screen.getByRole('region', { name: /Инструкция установки на iPhone/ });
  expect(guide).toBeVisible();
  expect(screen.getByText(/Откройте MirasChat именно в Safari/)).toBeVisible();
  expect(screen.getByText(/На экран „Домой“/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: /Закрыть инструкцию/ }));
  expect(guide).not.toBeInTheDocument();
});
