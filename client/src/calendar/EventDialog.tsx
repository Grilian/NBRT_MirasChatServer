import React, { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { nameFor } from '../utils/user';
import {
  DayKey, dayKeyOf, instantOf, minutesFromTimeInput, toDateInput, toTimeInput,
} from './dates';
import {
  CalendarOccurrence, CalendarScope, CalendarScopeKind, EVENT_COLORS, EventColor,
  EventDraft, RecurrenceFreq,
} from './types';
import { colorOfLayer } from './layers';

interface Person {
  id: number;
  username: string;
  display_name: string | null;
  department_id: number | null;
  department: string | null;
}

interface Department {
  id: number;
  name: string;
  member_count: number;
}

interface EventDialogProps {
  /** Область по умолчанию для нового события. */
  scope: CalendarScope;
  /** Показывать ли выбор «Мои события / Общий календарь». */
  canPublishGlobal: boolean;
  /** Редактируемое вхождение; null — создаём новое. */
  occurrence: CalendarOccurrence | null;
  /** Начало для нового события: клик по дню или по слоту сетки. */
  initialStart: number;
  initialAllDay?: boolean;
  onClose: () => void;
  onSave: (draft: EventDraft, editingId: number | null) => Promise<void>;
  onDelete: (eventId: number) => Promise<void>;
}

const REPEAT_OPTIONS: { value: RecurrenceFreq | 'none'; label: string }[] = [
  { value: 'none', label: 'Не повторять' },
  { value: 'daily', label: 'Ежедневно' },
  { value: 'weekly', label: 'Еженедельно' },
  { value: 'monthly', label: 'Ежемесячно' },
  { value: 'yearly', label: 'Ежегодно' },
];

const DEFAULT_DURATION_MINUTES = 60;

const EventDialog: React.FC<EventDialogProps> = ({
  scope, canPublishGlobal, occurrence, initialStart, initialAllDay, onClose, onSave, onDelete,
}) => {
  const editing = occurrence && occurrence.event_id !== null ? occurrence : null;

  // Область события: у существующего берём его собственную, у нового — ту, в
  // которой открыли календарь.
  const [scopeKind, setScopeKind] = useState<CalendarScopeKind>(
    editing?.scope_kind ?? scope.kind
  );

  const [title, setTitle] = useState(editing?.title ?? '');
  const [isTask, setIsTask] = useState(editing?.is_task ?? false);
  const [allDay, setAllDay] = useState(editing?.all_day ?? initialAllDay ?? false);
  const [startDay, setStartDay] = useState<DayKey>(
    toDateInput(editing?.starts_at ?? initialStart)
  );
  const [startTime, setStartTime] = useState(toTimeInput(editing?.starts_at ?? initialStart));
  const [endDay, setEndDay] = useState<DayKey>(
    toDateInput(editing?.ends_at ?? initialStart + DEFAULT_DURATION_MINUTES * 60000)
  );
  const [endTime, setEndTime] = useState(
    toTimeInput(editing?.ends_at ?? initialStart + DEFAULT_DURATION_MINUTES * 60000)
  );
  const [freq, setFreq] = useState<RecurrenceFreq | 'none'>(editing?.recurrence?.freq ?? 'none');
  const [interval, setInterval] = useState(String(editing?.recurrence?.interval ?? 1));
  const [until, setUntil] = useState(
    editing?.recurrence?.until ? toDateInput(editing.recurrence.until) : ''
  );
  // Цвет по умолчанию берём у слоя: событие в общем календаре сразу выглядит
  // общим, и в сетке видно, откуда оно, без чтения названия.
  const defaultColor = (colorOfLayer(scopeKind === 'global' ? 'global' : 'personal') as EventColor);
  const [color, setColor] = useState<EventColor>(
    (editing?.color === 'birthday' ? defaultColor : editing?.color) ?? defaultColor
  );
  const [location, setLocation] = useState(editing?.location ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [guestIds, setGuestIds] = useState<number[]>(
    editing?.guests.map((guest) => guest.user_id) ?? []
  );

  const [people, setPeople] = useState<Person[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [guestQuery, setGuestQuery] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Справочник целиком, а не только свои контакты: позвать на встречу можно
  // любого сотрудника, и отделами в том числе — иначе список отделов показывал
  // бы людей, которых нельзя выбрать.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get('/users'), api.get('/departments')])
      .then(([usersRes, departmentsRes]) => {
        if (cancelled) return;
        setPeople(usersRes.data);
        setDepartments(departmentsRes.data);
      })
      .catch(() => { /* без справочника диалог остаётся рабочим, просто некого звать */ });
    return () => { cancelled = true; };
  }, []);

  // Сдвигая начало, тянем за ним конец: иначе каждое изменение даты требует
  // править и вторую строку, а забытый конец даёт событие отрицательной длины.
  const handleStartDayChange = (value: DayKey) => {
    if (!value) return;
    const shift = Date.parse(`${value}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`);
    const shiftedEnd = new Date(Date.parse(`${endDay}T00:00:00Z`) + shift);
    setStartDay(value);
    setEndDay(shiftedEnd.toISOString().slice(0, 10));
  };

  // Пока в поиске пусто — предлагаем отделы, не людей. Список сотрудников
  // целиком длиннее экрана и заставляет вычитывать десятки имён; отделами
  // зовут чаще, а конкретного человека проще найти по имени, чем выбрать
  // из общего перечня.
  const matchedPeople = useMemo(() => {
    const needle = guestQuery.trim().toLowerCase();
    if (!needle) return [];
    return people
      .filter((person) => nameFor(person).toLowerCase().includes(needle))
      .slice(0, 8);
  }, [people, guestQuery]);

  const matchedDepartments = useMemo(() => {
    const needle = guestQuery.trim().toLowerCase();
    const withPeople = departments.filter((item) => item.member_count > 0);
    if (!needle) return withPeople;
    return withPeople.filter((item) => item.name.toLowerCase().includes(needle));
  }, [departments, guestQuery]);

  const selectedGuests = useMemo(
    () => people.filter((person) => guestIds.includes(person.id)),
    [people, guestIds]
  );

  const toggleGuest = (id: number) => {
    setGuestIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  // Отдел — это способ позвать разом, а не отдельная сущность в участниках:
  // состав отдела может смениться, а приглашены остаются те, кого позвали.
  const toggleDepartment = (departmentId: number) => {
    const members = people.filter((person) => person.department_id === departmentId).map((p) => p.id);
    if (members.length === 0) return;

    setGuestIds((current) => {
      const allInvited = members.every((id) => current.includes(id));
      if (allInvited) return current.filter((id) => !members.includes(id));
      return Array.from(new Set([...current, ...members]));
    });
  };

  const departmentState = (departmentId: number) => {
    const members = people.filter((person) => person.department_id === departmentId).map((p) => p.id);
    if (members.length === 0) return 'empty';
    if (members.every((id) => guestIds.includes(id))) return 'all';
    return members.some((id) => guestIds.includes(id)) ? 'some' : 'none';
  };

  const buildDraft = (): EventDraft | string => {
    const trimmed = title.trim();
    if (!trimmed) return 'Укажите название';

    // Событие на весь день занимает сутки целиком: минута до полуночи, а не
    // сама полночь, иначе оно залезало бы в следующий день одной точкой.
    const startsAt = allDay
      ? instantOf(startDay, 0)
      : instantOf(startDay, minutesFromTimeInput(startTime));
    const endsAt = allDay
      ? instantOf(endDay, 24 * 60) - 60000
      : instantOf(endDay, minutesFromTimeInput(endTime));

    if (endsAt < startsAt) return 'Конец раньше начала';

    const parsedInterval = Math.max(1, Number(interval) || 1);

    return {
      title: trimmed,
      description: description.trim() || null,
      location: location.trim() || null,
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: allDay,
      color,
      recurrence: freq === 'none'
        ? null
        : { freq, interval: parsedInterval, until: until ? instantOf(until, 24 * 60) : null },
      is_task: isTask,
      guest_ids: guestIds,
      scope_kind: scopeKind,
      scope_id: scopeKind === 'space' ? scope.id ?? null : null,
    };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const draft = buildDraft();
    if (typeof draft === 'string') {
      setError(draft);
      return;
    }

    setSaving(true);
    try {
      await onSave(draft, editing?.event_id ?? null);
      onClose();
    } catch {
      setError('Не удалось сохранить');
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing?.event_id) return;
    const question = editing.recurring
      ? 'Удалить всю серию повторяющихся событий?'
      : 'Удалить событие?';
    if (!window.confirm(question)) return;

    setSaving(true);
    try {
      await onDelete(editing.event_id);
      onClose();
    } catch {
      setError('Не удалось удалить');
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card cal-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="conv-head">
          <div className="cal-dialog-heading">{editing ? 'Событие' : 'Новое событие'}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <form className="cal-dialog-body" onSubmit={handleSubmit}>
          {error && <p className="form-error">{error}</p>}

          <div className="field">
            <label htmlFor="cal-title">Название</label>
            <input
              id="cal-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={isTask ? 'Что нужно сделать' : 'Например, планёрка'}
            />
          </div>

          <div className="cal-dialog-types">
            <button
              type="button"
              className={`cal-type${!isTask ? ' is-active' : ''}`}
              onClick={() => setIsTask(false)}
            >
              Событие
            </button>
            <button
              type="button"
              className={`cal-type${isTask ? ' is-active' : ''}`}
              onClick={() => setIsTask(true)}
            >
              Задача
            </button>
          </div>

          {/* Выбор календаря показываем только тем, кому есть из чего выбирать.
              Остальным строка «Мои события» ничего не сообщала бы, а место
              в диалоге занимала. */}
          {canPublishGlobal && scopeKind !== 'space' && (
            <div className="field">
              <label htmlFor="cal-scope">Календарь</label>
              <select
                id="cal-scope"
                value={scopeKind}
                onChange={(event) => {
                  const next = event.target.value as CalendarScopeKind;
                  setScopeKind(next);
                  // Цвет тянем за областью, пока человек не выбрал свой:
                  // иначе событие в общем календаре осталось бы «личного» цвета.
                  setColor(colorOfLayer(next === 'global' ? 'global' : 'personal') as EventColor);
                }}
              >
                <option value="personal">Мои события</option>
                <option value="global">Общий календарь</option>
              </select>
              {scopeKind === 'global' && (
                <p className="field-hint">Это событие увидят все сотрудники.</p>
              )}
            </div>
          )}

          <label className="cal-dialog-check">
            <input type="checkbox" checked={allDay} onChange={(event) => setAllDay(event.target.checked)} />
            <span>Весь день</span>
          </label>

          <div className="cal-dialog-when">
            <div className="field">
              <label htmlFor="cal-start-day">Начало</label>
              <div className="cal-dialog-datetime">
                <input
                  id="cal-start-day"
                  type="date"
                  value={startDay}
                  onChange={(event) => handleStartDayChange(event.target.value)}
                />
                {!allDay && (
                  <input
                    type="time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                )}
              </div>
            </div>

            <div className="field">
              <label htmlFor="cal-end-day">Конец</label>
              <div className="cal-dialog-datetime">
                <input
                  id="cal-end-day"
                  type="date"
                  value={endDay}
                  onChange={(event) => setEndDay(event.target.value)}
                />
                {!allDay && (
                  <input
                    type="time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="cal-repeat">Повтор</label>
            <div className="cal-dialog-repeat">
              <select
                id="cal-repeat"
                value={freq}
                onChange={(event) => setFreq(event.target.value as RecurrenceFreq | 'none')}
              >
                {REPEAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>

              {freq !== 'none' && (
                <>
                  <span className="cal-dialog-inline">каждые</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={interval}
                    onChange={(event) => setInterval(event.target.value)}
                    className="cal-dialog-interval"
                  />
                  <span className="cal-dialog-inline">до</span>
                  <input
                    type="date"
                    value={until}
                    onChange={(event) => setUntil(event.target.value)}
                    title="Оставьте пустым, чтобы повторять бессрочно"
                  />
                </>
              )}
            </div>
            {freq !== 'none' && !until && (
              <p className="field-hint">Без даты окончания событие повторяется бессрочно.</p>
            )}
          </div>

          <div className="field">
            <label>Цвет</label>
            <div className="cal-dialog-colors">
              {EVENT_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`cal-swatch cal-color-${option.value}${color === option.value ? ' is-active' : ''}`}
                  onClick={() => setColor(option.value)}
                  title={option.label}
                  aria-label={option.label}
                />
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="cal-place">Место</label>
            <input
              id="cal-place"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Кабинет, ссылка на встречу"
            />
          </div>

          <div className="field">
            <label htmlFor="cal-guests">Участники</label>
            {selectedGuests.length > 0 && (
              <div className="cal-dialog-guests">
                {selectedGuests.map((guest) => (
                  <button
                    key={guest.id}
                    type="button"
                    className="cal-guest-chip"
                    onClick={() => toggleGuest(guest.id)}
                    title="Убрать"
                  >
                    {nameFor(guest)}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                ))}
              </div>
            )}
            <input
              id="cal-guests"
              value={guestQuery}
              onChange={(event) => setGuestQuery(event.target.value)}
              placeholder="Отдел целиком или имя сотрудника"
            />

            {(matchedDepartments.length > 0 || matchedPeople.length > 0) && (
              <div className="cal-dialog-suggest">
                {matchedDepartments.map((item) => {
                  const state = departmentState(item.id);
                  return (
                    <button
                      key={`dept-${item.id}`}
                      type="button"
                      className={`cal-suggest-row is-department${state === 'all' ? ' is-picked' : ''}${state === 'some' ? ' is-partial' : ''}`}
                      onClick={() => toggleDepartment(item.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></svg>
                      <span className="cal-suggest-name">{item.name}</span>
                      <span className="cal-suggest-count">{item.member_count}</span>
                    </button>
                  );
                })}

                {matchedPeople.map((person) => (
                  <button
                    key={`user-${person.id}`}
                    type="button"
                    className={`cal-suggest-row${guestIds.includes(person.id) ? ' is-picked' : ''}`}
                    onClick={() => toggleGuest(person.id)}
                  >
                    <span className="cal-suggest-name">{nameFor(person)}</span>
                    {person.department && <span className="cal-suggest-count">{person.department}</span>}
                  </button>
                ))}
              </div>
            )}

            {!guestQuery.trim() && (
              <p className="field-hint">
                Отделы приглашаются целиком. Отдельного сотрудника найдите по имени.
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="cal-note">Описание</label>
            <textarea
              id="cal-note"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="cal-dialog-actions">
            {editing && (
              <button type="button" className="cal-dialog-delete" onClick={handleDelete} disabled={saving}>
                Удалить
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EventDialog;

/** День клика в сетке → момент начала по умолчанию для нового события. */
export function defaultStartFor(day: DayKey, minutes: number | null): number {
  return minutes === null ? instantOf(day, 9 * 60) : instantOf(day, minutes);
}

/** Для подписи «сегодня» в шапке диалога. */
export function isToday(ms: number): boolean {
  return dayKeyOf(ms) === dayKeyOf(Date.now());
}
