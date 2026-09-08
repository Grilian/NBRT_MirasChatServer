import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRange } from './api';
import { DayKey, addDays, instantOf, monthGrid, todayKey, weekDays } from './dates';
import { describeLayers, layerOf, loadDisabledLayers, saveDisabledLayers } from './layers';
import {
  CalendarLayer, CalendarOccurrence, CalendarScope, CalendarViewMode, GoogleCalendarLayer, LayerId,
} from './types';

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
  /** Только вхождения включённых слоёв — это то, что рисуют представления. */
  occurrences: CalendarOccurrence[];
  layers: CalendarLayer[];
  isLayerEnabled: (id: LayerId) => boolean;
  toggleLayer: (id: LayerId) => void;
  canPublishGlobal: boolean;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/**
 * Выбранный вид календаря переживает перезаход.
 *
 * Человек выбирает вид один раз и надолго: кто живёт лентой, тот живёт ею
 * всегда. Сбрасывать его на «Месяц» при каждом открытии значит заставлять
 * переключать заново — а это ровно то, на что и пожаловались при тестировании.
 *
 * На устройстве, а не на сервере: это настройка вида, как ширина списка чатов
 * и свёрнутость рельса, и синхронизировать её между телефоном и компьютером не
 * нужно — там разные виды и удобны.
 */
const VIEW_STORAGE_KEY = 'calendarViewMode';
const VIEW_MODES: CalendarViewMode[] = ['month', 'week', 'day', 'agenda'];

function loadViewMode(): CalendarViewMode {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved && (VIEW_MODES as string[]).includes(saved)) return saved as CalendarViewMode;
  } catch {
    // приватный режим — вернём умолчание, ронять календарь незачем
  }
  return 'month';
}

/**
 * Загрузка вхождений для текущего режима и даты.
 *
 * С сервера приходит всё, что человеку положено видеть, одним ответом, а
 * разделение на слои и фильтрация делаются здесь: переключить слой не должно
 * значить сходить на сервер за тем, что уже загружено.
 *
 * scope задаётся только для врезок вроде списка в карточке пространства — там
 * нужен один слой, а не весь календарь.
 */
export function useCalendarData(scope?: CalendarScope, changeToken = 0): CalendarData {
  const [mode, setModeState] = useState<CalendarViewMode>(loadViewMode);
  const setMode = useCallback((next: CalendarViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // не смогли запомнить — вид всё равно сменится, просто на этот раз
    }
  }, []);
  const [anchor, setAnchor] = useState<DayKey>(todayKey);
  const [all, setAll] = useState<CalendarOccurrence[]>([]);
  const [canPublishGlobal, setCanPublishGlobal] = useState(false);
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendarLayer[]>([]);
  const [disabled, setDisabled] = useState<Set<LayerId>>(loadDisabledLayers);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const { from, to } = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchRange(from, to, scope)
      .then((data) => {
        if (cancelled) return;
        // Дни рождения приезжают отдельным массивом, но дальше живут наравне с
        // остальными: слой у них свой, а обращение одинаковое.
        setAll([...data.events, ...data.birthdays]);
        setCanPublishGlobal(data.canPublishGlobal);
        setGoogleCalendars(data.googleCalendars);
        setError(false);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // scope — объект, в зависимостях он бы менялся каждый рендер; разбираем на поля.
    // changeToken — сигнал извне, что события изменились не из этого окна:
    // синхронизация с Google приносит их фоном, и без него импортированное
    // появлялось бы только после перелистывания месяца.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.kind, scope?.id, from, to, reloadToken, changeToken]);

  const layers = useMemo(
    () => describeLayers(all, {}, googleCalendars),
    [all, googleCalendars]
  );

  const isLayerEnabled = useCallback((id: LayerId) => !disabled.has(id), [disabled]);

  const occurrences = useMemo(
    () => all.filter((item) => !disabled.has(layerOf(item))),
    [all, disabled]
  );

  const toggleLayer = useCallback((id: LayerId) => {
    setDisabled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveDisabledLayers(next);
      return next;
    });
  }, []);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return {
    mode, setMode,
    anchor, setAnchor,
    occurrences,
    layers, isLayerEnabled, toggleLayer,
    canPublishGlobal,
    loading, error,
    reload,
  };
}
