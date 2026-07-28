// Календарь задуман как виджет, а не раздел: тот же компонент предстоит
// показывать внутри пространств. Всё, что отличает один календарь от другого,
// собрано здесь, в scope — дальше по коду он просто прокидывается вниз, и ни
// одному представлению не нужно знать, чей календарь оно рисует.
export type CalendarScopeKind = 'personal' | 'space';

export interface CalendarScope {
  kind: CalendarScopeKind;
  /** id пространства; у личного календаря его нет. */
  id?: number | null;
}

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda';

export type EventColor = 'blue' | 'green' | 'red' | 'orange' | 'violet' | 'teal' | 'graphite';

export const EVENT_COLORS: { value: EventColor; label: string }[] = [
  { value: 'blue', label: 'Синий' },
  { value: 'green', label: 'Зелёный' },
  { value: 'red', label: 'Красный' },
  { value: 'orange', label: 'Оранжевый' },
  { value: 'violet', label: 'Фиолетовый' },
  { value: 'teal', label: 'Бирюзовый' },
  { value: 'graphite', label: 'Графитовый' },
];

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number;
  until: number | null;
}

export interface EventGuest {
  user_id: number;
  response: 'pending' | 'accepted' | 'declined';
  display_name: string;
  avatar_path: string | null;
}

/**
 * Вхождение события, а не событие: повторяющаяся встреча приходит с сервера
 * уже развёрнутой в отдельные вхождения. Клиенту не нужно знать правила
 * повторения, чтобы нарисовать сетку, — он получает готовые моменты.
 */
export interface CalendarOccurrence {
  /** Уникален для вхождения: `${event_id}:${occurrence_start}`. */
  id: string;
  /** null у дней рождения — их нельзя открыть на редактирование. */
  event_id: number | null;
  occurrence_start: number;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: number;
  ends_at: number;
  all_day: boolean;
  color: EventColor | 'birthday';
  is_task: boolean;
  completed: boolean;
  recurring: boolean;
  recurrence: Recurrence | null;
  scope_kind: CalendarScopeKind;
  scope_id: number | null;
  owner_id: number;
  is_owner: boolean;
  source: 'calendar' | 'birthday';
  guests: EventGuest[];
}

/** Тело запроса на создание и правку — форма одна и та же. */
export interface EventDraft {
  title: string;
  description: string | null;
  location: string | null;
  starts_at: number;
  ends_at: number;
  all_day: boolean;
  color: EventColor;
  recurrence: Recurrence | null;
  is_task: boolean;
  guest_ids: number[];
  scope_kind: CalendarScopeKind;
  scope_id: number | null;
}

/**
 * Слои календаря. Пока их два, но список задуман расширяемым: календари
 * пространств лягут сюда же, и переключатель слоёв не придётся переделывать.
 */
export interface CalendarLayer {
  id: 'events' | 'birthdays';
  label: string;
  enabled: boolean;
}
