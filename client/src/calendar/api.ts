import api from '../api/client';
import { CalendarOccurrence, CalendarScope, EventDraft } from './types';

interface RangeResponse {
  events: CalendarOccurrence[];
  birthdays: CalendarOccurrence[];
}

function scopeParams(scope: CalendarScope) {
  return { scope_kind: scope.kind, scope_id: scope.id ?? undefined };
}

/**
 * Вхождения диапазона. Слои возвращаются раздельно, чтобы переключатель
 * «Дни рождения» не требовал повторного запроса — данные уже на руках.
 */
export async function fetchRange(
  scope: CalendarScope,
  from: number,
  to: number
): Promise<RangeResponse> {
  const { data } = await api.get('/calendar/events', {
    params: { from, to, ...scopeParams(scope) },
  });
  return { events: data.events || [], birthdays: data.birthdays || [] };
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
