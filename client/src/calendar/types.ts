// Календарь задуман как виджет, а не раздел: тот же компонент предстоит
// показывать внутри пространств. Всё, что отличает один календарь от другого,
// собрано здесь, в scope — дальше по коду он просто прокидывается вниз, и ни
// одному представлению не нужно знать, чей календарь оно рисует.
export type CalendarScopeKind = 'personal' | 'global' | 'space';

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
  /**
   * Права на правку решает сервер, а не клиент: у общего события их имеет любой
   * администратор или модератор, а не только автор, и вычислять это по
   * owner_id на клиенте значило бы дублировать правило в двух местах.
   */
  can_edit: boolean;
  /**
   * Позвали ли именно этого человека. Отличает «меня пригласили» от «я вижу
   * общее событие»: отвечать на приглашение можно только в первом случае.
   */
  is_guest: boolean;
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
 * Слой календаря — то, что человек включает и выключает в боковой панели.
 *
 * Идентификатор строковый и с префиксом (`space:7`), потому что слоёв
 * пространств будет столько, сколько пространств: перечислением их не задать.
 * Календарь показывает объединение включённых слоёв, а не одну область.
 */
export type LayerId = 'global' | 'personal' | 'birthdays' | string;

export interface CalendarLayer {
  id: LayerId;
  label: string;
  /**
   * Цвет слоя. Он же цвет по умолчанию для событий, создаваемых в этом слое:
   * когда слоёв много, одинаково синие события из разных источников
   * перестают читаться в сетке. Цвет конкретного события его переопределяет.
   */
  color: EventColor | 'birthday';
  count: number;
}
