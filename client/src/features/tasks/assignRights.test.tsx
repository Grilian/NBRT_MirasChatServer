import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaskDialog from './TaskDialog';
import { TaskItem } from './types';

vi.mock('@/shared/api/client', () => ({
  __esModule: true,
  default: { get: vi.fn(() => Promise.resolve({ data: [] })) },
}));

const person = (id: number, name: string) => ({
  id, username: name, display_name: name, avatar_path: null,
});

/** Задача чужая: править нельзя, но передать вправе текущий исполнитель — я. */
const task: TaskItem = {
  id: 13, title: 'Чернильцы', description: null, status: 'not_started',
  due_at: null, created_at: 0, updated_at: 0, completed_at: null,
  created_by: person(97, 'Автор'),
  assignee: person(39, 'Я'),
  participants: [person(39, 'Я'), person(97, 'Автор')],
  source: { kind: 'manual', ref: null, label: null },
  can_edit: false, can_assign: true, archived: false, deleted: false,
} as TaskItem;

test('сдав работу, человек теряет право передавать — и ему это сказано', async () => {
  // Живая находка на проде 08.09.2026: человек передал задачу и получил три
  // отказа 403 подряд. Ряд имён оставался нажимаемым, потому что право
  // считалось один раз при открытии, а меняется оно прямо здесь.
  const onAssigneeChange = vi.fn(async () => ({
    ...task,
    assignee: person(97, 'Автор'),
    can_assign: false,
  }) as TaskItem);

  render(
    <TaskDialog
      task={task}
      currentUserId={39}
      currentUserName="Я"
      currentUsername="me"
      onClose={vi.fn()}
      onSave={vi.fn()}
      onAssigneeChange={onAssigneeChange}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Автор' }));

  await waitFor(() => expect(onAssigneeChange).toHaveBeenCalledWith(97));
  // Ряда имён больше нет — но и молчания тоже нет.
  await waitFor(() => {
    expect(screen.getByText(/Задача передана/)).toBeInTheDocument();
  });
  expect(screen.queryByRole('button', { name: 'Автор' })).toBeNull();
  // И строка просмотра показывает НОВОГО исполнителя, а не того, что был.
  expect(screen.getByText(/Исполнитель: Автор/)).toBeInTheDocument();
});
