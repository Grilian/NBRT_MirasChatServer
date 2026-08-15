import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../api/client';
import FilesSection from './FilesSection';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../utils/downloadFile', () => ({
  downloadFile: jest.fn().mockResolvedValue({ ok: true, location: 'Загрузки' }),
}));

const mockedApi = api as unknown as { get: jest.Mock; post: jest.Mock };

const ITEMS = [
  {
    message_id: 1, kind: 'document', name: 'договор.pdf', path: '/uploads/users/1/files/a.pdf',
    size: 1000, mime: 'application/pdf', width: null, height: null, category: 'documents',
    created_at: '2026-08-15 10:00:00', chat_id: 'chat_1_2', chat_name: 'Борис', chat_kind: 'direct',
    archived_at: null, can_open: true,
  },
  {
    message_id: 2, kind: 'document', name: 'песня.mp3', path: '/uploads/users/1/files/b.mp3',
    size: 5000, mime: 'audio/mpeg', width: null, height: null, category: 'music',
    created_at: '2026-08-15 10:01:00', chat_id: 'general', chat_name: 'Общий чат', chat_kind: 'general',
    archived_at: null, can_open: true,
  },
];

const SUMMARY = {
  total_bytes: 6000,
  documents_count: 2,
  images_count: 0,
  archived_count: 3,
  bytes_by_category: { documents: 1000, files: 0, images: 0, music: 5000 },
  count_by_category: { documents: 1, files: 0, images: 0, music: 1 },
};

beforeEach(() => {
  mockedApi.get.mockReset();
  mockedApi.post.mockReset();
  mockedApi.get.mockImplementation((url: string, config?: any) => {
    if (url === '/files/summary') return Promise.resolve({ data: SUMMARY });
    const archived = config?.params?.archived === 1;
    return Promise.resolve({ data: { items: archived ? [] : ITEMS } });
  });
});

test('показывает свои файлы, чат-источник и занятое место', async () => {
  render(<FilesSection />);

  expect(await screen.findByText('договор.pdf')).toBeInTheDocument();
  expect(screen.getByText(/Борис/)).toBeInTheDocument();
  // Подпись склоняется: «2 файла», а не «2 файлов».
  expect(screen.getByText(/2 файла из ваших сообщений/)).toBeInTheDocument();
});

test('категория отбирает список, не ходя на сервер заново', async () => {
  render(<FilesSection />);
  await screen.findByText('договор.pdf');
  const callsBefore = mockedApi.get.mock.calls.length;

  fireEvent.click(screen.getByRole('button', { name: /^Музыка/ }));

  expect(screen.queryByText('договор.pdf')).not.toBeInTheDocument();
  expect(screen.getByText('песня.mp3')).toBeInTheDocument();
  expect(mockedApi.get.mock.calls.length).toBe(callsBefore);
});

test('сортировка и архив перезапрашивают список у сервера', async () => {
  render(<FilesSection />);
  await screen.findByText('договор.pdf');

  fireEvent.change(screen.getByLabelText('Порядок'), { target: { value: 'big' } });
  await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith(
    '/files',
    expect.objectContaining({ params: expect.objectContaining({ sort: 'big' }) })
  ));

  fireEvent.click(screen.getByRole('button', { name: /Архив/ }));
  await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith(
    '/files',
    expect.objectContaining({ params: expect.objectContaining({ archived: 1 }) })
  ));
  expect(await screen.findByText('В архиве пусто')).toBeInTheDocument();
});

test('удаление уводит файл в архив и обновляет сводку', async () => {
  mockedApi.post.mockResolvedValue({ data: {} });
  const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
  render(<FilesSection />);
  await screen.findByText('договор.pdf');

  fireEvent.click(screen.getByRole('button', { name: 'Действия с договор.pdf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

  await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith('/messages/1/attachment/archive'));
  await waitFor(() => expect(screen.queryByText('договор.pdf')).not.toBeInTheDocument());
  // Сводка перечитывается: ради занятого места сюда и приходят.
  expect(mockedApi.get).toHaveBeenCalledWith('/files/summary');
  confirmSpy.mockRestore();
});

test('переход к сообщению отдаёт наверх чат и сообщение', async () => {
  const onOpenMessage = jest.fn();
  render(<FilesSection onOpenMessage={onOpenMessage} />);
  await screen.findByText('песня.mp3');

  fireEvent.click(screen.getByRole('button', { name: 'Действия с песня.mp3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Перейти к сообщению' }));

  expect(onOpenMessage).toHaveBeenCalledWith('general', 2);
});

test('массовые действия появляются только при выборе', async () => {
  render(<FilesSection />);
  await screen.findByText('договор.pdf');
  expect(screen.queryByText(/Выбрано:/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать договор.pdf' }));
  expect(screen.getByText('Выбрано: 1')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Снять выбор' }));
  expect(screen.queryByText(/Выбрано:/)).not.toBeInTheDocument();
});
