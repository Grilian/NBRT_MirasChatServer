// «Кто может писать» — единый набор режимов для групповых чатов. Значения
// совпадают со строками в chat_groups.write_policy на сервере
// (server/services/chatPermissions.js); менять их можно только вместе.
export type WritePolicy = 'all' | 'members' | 'departments' | 'admins' | 'nobody';

export const WRITE_POLICY_ORDER: WritePolicy[] = ['all', 'members', 'departments', 'admins', 'nobody'];

export const WRITE_POLICY_LABELS: Record<WritePolicy, string> = {
  all: 'Все участники',
  members: 'Выбранные участники',
  departments: 'Выбранные отделы',
  admins: 'Только администрация',
  nobody: 'Никто',
};

// Подпись под композером, когда писать нельзя. Причина названа прямо: иначе
// человек видит просто мёртвое поле и не понимает, почему.
export const WRITE_BLOCKED_HINT: Record<WritePolicy, string> = {
  all: 'В этот чат нельзя писать',
  members: 'Писать в этот чат могут только выбранные участники',
  departments: 'Писать в этот чат могут только выбранные отделы',
  admins: 'Писать в этот чат может только администрация',
  nobody: 'Чат закрыт для сообщений',
};
