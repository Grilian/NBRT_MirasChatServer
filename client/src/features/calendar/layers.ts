import { CalendarLayer, CalendarOccurrence, EventColor, GoogleCalendarLayer, LayerId } from './types';

const googleCalendarById = (
  id: LayerId,
  googleCalendars: GoogleCalendarLayer[]
): GoogleCalendarLayer | undefined => {
  const sourceId = Number(id.split(':')[1]);
  return googleCalendars.find((c) => c.id === sourceId);
};

// Календарь показывает объединение слоёв, а не одну область. Слои описываются
// здесь, потому что правило «к какому слою относится вхождение» нужно и сетке,
// и боковой панели, и диалогу создания.

const STORAGE_KEY = 'calendar_layers_off';

// Цвет слоя. Он же цвет по умолчанию для событий, создаваемых в нём: когда
// слоёв станет пять, одинаково синие события из разных источников перестанут
// различаться в сетке месяца.
const LAYER_COLORS: Record<string, EventColor> = {
  global: 'red',
  personal: 'blue',
};

// Палитра для пространств: их число заранее неизвестно, поэтому цвет
// назначается по идентификатору — у одного пространства он всегда один и тот же.
const SPACE_PALETTE: EventColor[] = ['violet', 'teal', 'green', 'orange', 'graphite'];

export function layerOf(occurrence: CalendarOccurrence): LayerId {
  if (occurrence.source === 'birthday') return 'birthdays';
  if (occurrence.scope_kind === 'global') return 'global';
  if (occurrence.scope_kind === 'space') return `space:${occurrence.scope_id}`;
  if (occurrence.scope_kind === 'gcal') return `gcal:${occurrence.scope_id}`;
  return 'personal';
}

export function colorOfLayer(id: LayerId, googleCalendars: GoogleCalendarLayer[] = []): EventColor | 'birthday' {
  if (id === 'birthdays') return 'birthday';
  if (LAYER_COLORS[id]) return LAYER_COLORS[id];
  // Цвет календаря Google задан в панели, а не выведен из номера: их подключают
  // по одному и осознанно, и «какой достался» тут не годится.
  if (id.startsWith('gcal:')) {
    return googleCalendarById(id, googleCalendars)?.color || 'violet';
  }
  const spaceId = Number(id.split(':')[1]);
  return SPACE_PALETTE[Math.abs(spaceId) % SPACE_PALETTE.length] || 'graphite';
}

function labelOfLayer(
  id: LayerId,
  spaceNames: Record<number, string>,
  googleCalendars: GoogleCalendarLayer[]
): string {
  if (id === 'global') return 'Общий календарь';
  if (id === 'personal') return 'Мои события';
  if (id === 'birthdays') return 'Дни рождения';
  if (id.startsWith('gcal:')) {
    return googleCalendarById(id, googleCalendars)?.name || 'Календарь Google';
  }
  const spaceId = Number(id.split(':')[1]);
  return spaceNames[spaceId] || `Пространство ${spaceId}`;
}

// Порядок в панели фиксирован: общее сверху, личное под ним, дни рождения
// последними. Пространства встают между личным и днями рождения в порядке
// появления — так список не перетасовывается от загрузки к загрузке.
const ORDER: LayerId[] = ['global', 'personal'];

/**
 * Слои, которые есть смысл показать: те, где что-то нашлось, плюс всегда
 * присутствующие личные. Пустой слой в панели — это строка, которая ничего не
 * значит и только занимает место.
 */
export function describeLayers(
  occurrences: CalendarOccurrence[],
  spaceNames: Record<number, string> = {},
  googleCalendars: GoogleCalendarLayer[] = []
): CalendarLayer[] {
  const counts = new Map<LayerId, number>();
  for (const occurrence of occurrences) {
    const id = layerOf(occurrence);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  // Личное и дни рождения показываем всегда: их отсутствие сегодня не значит,
  // что человек не захочет их включить.
  for (const id of ['personal', 'birthdays'] as LayerId[]) {
    if (!counts.has(id)) counts.set(id, 0);
  }

  // Подключённый календарь Google показываем даже пустым: в открытом месяце
  // мероприятий может не быть вовсе, а слой, пропадающий из панели вместе с
  // ними, читается как «отключился сам».
  for (const calendar of googleCalendars) {
    const id = `gcal:${calendar.id}`;
    if (!counts.has(id)) counts.set(id, 0);
  }

  const ids = Array.from(counts.keys()).sort((a, b) => {
    const rank = (id: LayerId) => {
      const fixed = ORDER.indexOf(id);
      if (fixed !== -1) return fixed;
      return id === 'birthdays' ? 100 : 50;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  return ids.map((id) => ({
    id,
    label: labelOfLayer(id, spaceNames, googleCalendars),
    color: colorOfLayer(id, googleCalendars),
    count: counts.get(id) || 0,
  }));
}

/**
 * Хранятся именно выключенные слои, а не включённые.
 *
 * Разница важна: когда человека добавят в новое пространство, его слой должен
 * появиться включённым. Храни мы список включённых — новый слой пришлось бы
 * считать выключенным, и события молча не показывались бы.
 */
export function loadDisabledLayers(): Set<LayerId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

export function saveDisabledLayers(disabled: Set<LayerId>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(disabled)));
  } catch {
    // Приватный режим или переполненное хранилище — переключатели просто не
    // переживут перезапуск. Ронять из-за этого календарь незачем.
  }
}
