// Общие подписи для Тип/Роль — единый источник истины для панели супер-админа
// и встроенного админ-управления в профиле (доступного роли "Администратор").
export type AccountType = 'staff' | 'internet' | 'miras';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  staff: 'Сотрудник',
  internet: 'Интернет',
  miras: 'Мирас',
};

export const ROLE_LABELS: Record<string, string> = {
  user: 'Сотрудник',
  moderator: 'Модератор',
  admin: 'Администратор',
};
