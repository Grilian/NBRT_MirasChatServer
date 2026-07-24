// SQLite's CURRENT_TIMESTAMP produces 'YYYY-MM-DD HH:MM:SS' with no timezone
// marker. `new Date(...)` on that string is misparsed as *local* time instead
// of UTC, which silently shifts every historical timestamp by the viewer's
// UTC offset. Live socket messages already use a proper ISO string (with a
// trailing 'Z') and parse correctly — this just makes both paths consistent.
export function parseServerDate(value: string): Date {
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  return new Date(iso);
}

// The app always displays Moscow time regardless of the viewer's own
// timezone — MirasChat's users are all in one place, the display shouldn't
// depend on whichever timezone happens to be set on a given device.
export function formatMoscowTime(value: string): string {
  return parseServerDate(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });
}

// Дата рождения хранится как 'YYYY-MM-DD' (формат <input type="date">) —
// показываем как привычное ДД.ММ.ГГГГ, без часового пояса (это календарная
// дата, а не момент времени, конвертировать её незачем).
export function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}.${month}.${year}`;
}
