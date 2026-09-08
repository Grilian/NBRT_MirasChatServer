import type { Mock } from 'vitest';
import api from '@/shared/api/client';
import { fetchTasks } from './api';

vi.mock('@/shared/api/client', () => ({
  __esModule: true,
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const mocked = api as unknown as { get: Mock };

test('задача с сервера прежнего образца не роняет доску', async () => {
  // Клиент способен опередить сервер: на личном тестировании сборка с новым
  // разделом задач смотрела на прод, где `source` и `assignee` ещё не
  // появились, и `task.source.kind` ронял отрисовку всей доски.
  mocked.get.mockResolvedValue({
    data: [{ id: 1, title: 'Старая задача', status: 'not_started', created_by: { id: 2 } }],
  });

  const [task] = await fetchTasks();

  expect(task.source).toEqual({ kind: 'manual', ref: null, label: null });
  expect(task.assignee).toBeNull();
  expect(task.can_assign).toBe(false);
  expect(task.participants).toEqual([]);
  expect(task.title).toBe('Старая задача');
});

test('поля нынешнего сервера остаются как есть', async () => {
  mocked.get.mockResolvedValue({
    data: [{
      id: 2, title: 'Новая', status: 'in_progress', created_by: { id: 2 },
      assignee: { id: 3 }, source: { kind: 'chat', ref: '7', label: 'Отдел' },
      can_assign: true, deleted: false, participants: [{ id: 3 }],
    }],
  });

  const [task] = await fetchTasks();

  expect(task.assignee).toEqual({ id: 3 });
  expect(task.source).toEqual({ kind: 'chat', ref: '7', label: 'Отдел' });
  expect(task.can_assign).toBe(true);
});
