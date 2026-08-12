import api from '../api/client';
import { CalendarOccurrence, CalendarScope, EventDraft, GoogleCalendarLayer } from './types';

interface RangeResponse {
  events: CalendarOccurrence[];
  birthdays: CalendarOccurrence[];
  canPublishGlobal: boolean;
  /** Подключённые дополнительные календари Google — по слою на каждый. */
  googleCalendars: GoogleCalendarLayer[];
}

/**
 * Вхождения диапазона.
 *
 * Без scope сервер отдаёт всё, что человеку положено видеть, — общее и личное
 * вместе, каждое со своим scope_kind. Разделение на слои делает клиент, чтобы
 * переключение слоя не требовало повторного запроса.
 *
 * Со scope — только одна область: для врезок вроде списка событий в карточке
 * пространства, где весь календарь не нужен.
 */
export async function fetchRange(
  from: number,
  to: number,
  scope?: CalendarScope
): Promise<RangeResponse> {
  const { data } = await api.get('/calendar/events', {
    params: {
      from,
      to,
      ...(scope ? { scope_kind: scope.kind, scope_id: scope.id ?? undefined } : {}),
    },
  });
  return {
    events: data.events || [],
    birthdays: data.birthdays || [],
    canPublishGlobal: !!data.can_publish_global,
    googleCalendars: data.google_calendars || [],
  };
}

export async function createEvent(draft: EventDraft): Promise<number> {
  const { data } = await api.post('/calendar/events', draft);
  return data.id;
}

export async function updateEvent(id: number, draft: EventDraft): Promise<void> {
  await api.put(`/calendar/events/${id}`, draft);
}

export async function deleteEvent(id: number): Promise<void> {
  await api.delete(`/calendar/events/${id}`);
}

/**
 * Правка одного вхождения серии: перенести или переименовать только его.
 * occurrenceStart — место вхождения в серии, а не новое время.
 */
export async function updateOccurrence(
  id: number,
  occurrenceStart: number,
  draft: EventDraft
): Promise<void> {
  await api.put(`/calendar/events/${id}/occurrence`, { ...draft, occurrence_start: occurrenceStart });
}

/** Отменить одно вхождение, оставив серию. */
export async function deleteOccurrence(id: number, occurrenceStart: number): Promise<void> {
  await api.delete(`/calendar/events/${id}/occurrence`, { params: { occurrence_start: occurrenceStart } });
}

export async function setTaskCompleted(
  eventId: number,
  occurrenceStart: number,
  completed: boolean
): Promise<void> {
  await api.post(`/calendar/events/${eventId}/complete`, {
    occurrence_start: occurrenceStart,
    completed,
  });
}

export async function respondToInvite(
  eventId: number,
  response: 'accepted' | 'declined' | 'pending'
): Promise<void> {
  await api.post(`/calendar/events/${eventId}/response`, { response });
}
