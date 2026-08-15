import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../api/client';
import ChatAttachments from './ChatAttachments';

jest.mock('../api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

const mockedApi = api as unknown as { get: jest.Mock; post: jest.Mock };

const MEDIA = [
  { id: 11, file_path: '/uploads/users/1/images/mine.webp', file_width: 10, file_height: 10, created_at: '2026-08-15 10:00:00', sender_id: 1 },
  { id: 12, file_path: '/uploads/users/2/images/theirs.webp', file_width: 10, file_height: 10, created_at: '2026-08-15 10:01:00', sender_id: 2 },
];

const FILES = [
  { id: 21, document_path: '/uploads/users/1/files/a.pdf', document_name: 'договор.pdf', document_size: 100, category: 'documents', created_at: '2026-08-15 10:00:00', sender_id: 1 },
  { id: 22, document_path: '/uploads/users/1/files/b.mp3', document_name: 'песня.mp3', document_size: 200, category: 'music', created_at: '2026-08-15 10:01:00', sender_id: 1 },
];

beforeEach(() => {
  mockedApi.get.mockReset();
  mockedApi.post.mockReset();
  mockedApi.get.mockImplementation((_url: string, config?: any) => {
    const kind = config?.params?.kind;
    if (kind === 'files') return Promise.resolve({ data: { kind, items: FILES } });
    if (kind === 'links') return Promise.resolve({ data: { kind, items: [] } });
    return Promise.resolve({ data: { kind: 'media', items: MEDIA } });
  });
});

const setup = (props: Partial<React.ComponentProps<typeof ChatAttachments>> = {}) => render(
  <ChatAttachments chatId="chat_1_2" currentUserId={1} onOpenMessage={jest.fn()} {...props} />
);

test('нажатие на своё изображение открывает меню с удалением', async () => {
  setup();
  const tiles = await screen.findAllByRole('button', { name: /^Изображение от/ });
  // Первая плитка — своя (sender_id === currentUserId).
  fireEvent.click(tiles[0]);

  expect(screen.getByRole('button', { name: 'Перейти к сообщению' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Скачать' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
});

test('у чужого изображения удаления в меню нет — только переход и скачивание', async () => {
  setup();
  const tiles = await screen.findAllByRole('button', { name: /^Изображение от/ });
  fireEvent.click(tiles[1]);

  expect(screen.getByRole('button', { name: 'Перейти к сообщению' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
});

test('переход к сообщению отдаёт наверх чат и id сообщения', async () => {
  const onOpenMessage = jest.fn();
  setup({ onOpenMessage });
  const tiles = await screen.findAllByRole('button', { name: /^Изображение от/ });
  fireEvent.click(tiles[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Перейти к сообщению' }));

  expect(onOpenMessage).toHaveBeenCalledWith('chat_1_2', 11);
});

test('удаление уводит файл в архив и убирает его из списка', async () => {
  mockedApi.post.mockResolvedValue({ data: {} });
  const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
  setup();

  fireEvent.click(await screen.findByRole('button', { name: 'Файлы' }));
  const row = await screen.findByText('договор.pdf');
  fireEvent.click(row);
  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

  await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith('/messages/21/attachment/archive'));
  // Строка пропадает сразу, не дожидаясь перезагрузки списка.
  await waitFor(() => expect(screen.queryByText('договор.pdf')).not.toBeInTheDocument());
  confirmSpy.mockRestore();
});

test('категории отбирают файлы по виду', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Файлы' }));

  expect(await screen.findByText('договор.pdf')).toBeInTheDocument();
  expect(screen.getByText('песня.mp3')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Категория: Музыка' }));
  expect(screen.queryByText('договор.pdf')).not.toBeInTheDocument();
  expect(screen.getByText('песня.mp3')).toBeInTheDocument();

  // Пустая категория говорит об этом, а не показывает пустоту без объяснения.
  fireEvent.click(screen.getByRole('button', { name: 'Категория: Изображения' }));
  expect(screen.getByText('В этой категории ничего нет')).toBeInTheDocument();
});
