import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRange } from './api';
import { DayKey, addDays, instantOf, monthGrid, todayKey, weekDays } from './dates';
import { CalendarOccurrence, CalendarScope, CalendarViewMode } from './types';

// Сколько дней вперёд показывает «Расписание». Достаточно, чтобы список не
// обрывался на пустом месте, и не столько, чтобы тянуть полгода событий.
const AGENDA_DAYS = 90;

/** Диапазон, который нужно загрузить для режима. Границы — по московским суткам. */
export function rangeFor(mode: CalendarViewMode, anchor: DayKey): { from: number; to: number } {
  if (mode === 'month') {
    const weeks = monthGrid(anchor);
    return {
      from: instantOf(weeks[0][0], 0),
      to: instantOf(weeks[5][6], 24 * 60),
    };
  }
  if (mode === 'week') {
    const days = weekDays(anchor);
    return { from: instantOf(days[0], 0), to: instantOf(days[6], 24 * 60) };
  }
  if (mode === 'day') {
    return { from: instantOf(anchor, 0), to: instantOf(anchor, 24 * 60) };
  }
  return { from: instantOf(anchor, 0), to: instantOf(addDays(anchor, AGENDA_DAYS), 24 * 60) };
}

interface CalendarData {
  mode: CalendarViewMode;
  setMode: (mode: CalendarViewMode) => void;
  anchor: DayKey;
  setAnchor: (day: DayKey) => void;
  occurrences: CalendarOccurrence[];
  loading: boolean;
  error: boolean;
  showBirthdays: boolean;
  setShowBirthdays: (value: boolean) => void;
  reload: () => void;
}

/**
 * Загрузка вхождений для текущего режима и даты.
 *
 * Слои держим раздельно и склеиваем на выходе: переключение «Дней рождения»
 * не должно ходить на сервер за тем, что уже загружено.
 */
export function useCalendarData(scope: CalendarScope): CalendarData {
  const [mode, setMode] = useState<CalendarViewMode>('month');
  const [anchor, setAnchor] = useState<DayKey>(todayKey);
  const [events, setEvents] = useState<CalendarOccurrence[]>([]);
  const [birthdays, setBirthdays] = useState<CalendarOccurrence[]>([]);
  const [showBirthdays, setShowBirthdays] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const { from, to } = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchRange(scope, from, to)
      .then((data) => {
        if (cancelled) return;
        setEvents(data.events);
        setBirthdays(data.birthdays);
        setError(false);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // scope — объект, в зависимостях он бы менялся каждый рендер; разбираем на поля.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind, scope.id, from, to, reloadToken]);

  const occurrences = useMemo(() => {
    const merged = showBirthdays ? [...events, ...birthdays] : events;
    return merged.sort((a, b) => a.starts_at - b.starts_at);
  }, [events, birthdays, showBirthdays]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return {
    mode, setMode,
    anchor, setAnchor,
    occurrences,
    loading, error,
    showBirthdays, setShowBirthdays,
    reload,
  };
}
