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

// Календарный день по московскому времени в виде 'YYYY-MM-DD'. Сравнивать
// сообщения по дням нужно именно в той зоне, в которой мы их показываем:
// иначе у человека в другом часовом поясе разделитель дат встанет не там,
// где проходит смена суток на экране.
export function moscowDayKey(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parseServerDate(value));
}

// Подпись разделителя дней в переписке: «Сегодня», «Вчера» или дата.
// Раньше над историей всегда стояло жёстко зашитое «Сегодня» — даже над
// перепиской годичной давности, и понять, когда что было сказано, было нельзя.
export function formatDaySeparator(value: string): string {
  const key = moscowDayKey(value);
  const now = new Date();
  const todayKey = moscowDayKey(now.toISOString());
  const yesterdayKey = moscowDayKey(new Date(now.getTime() - 86400000).toISOString());

  if (key === todayKey) return 'Сегодня';
  if (key === yesterdayKey) return 'Вчера';

  const date = parseServerDate(value);
  const sameYear = key.slice(0, 4) === todayKey.slice(0, 4);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

// Время последнего сообщения в списке чатов: сегодняшнее — часами, вчерашнее —
// словом, более старое — датой. Так же ведёт себя список чатов в Telegram;
// раньше здесь всегда показывались часы, и сообщение недельной давности
// выглядело как только что пришедшее.
export function formatChatListTime(value: string): string {
  const key = moscowDayKey(value);
  const now = new Date();
  const todayKey = moscowDayKey(now.toISOString());
  const yesterdayKey = moscowDayKey(new Date(now.getTime() - 86400000).toISOString());

  if (key === todayKey) return formatMoscowTime(value);
  if (key === yesterdayKey) return 'вчера';

  const sameYear = key.slice(0, 4) === todayKey.slice(0, 4);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    ...(sameYear ? {} : { year: '2-digit' }),
  }).format(parseServerDate(value));
}

// Дата рождения хранится как 'YYYY-MM-DD' (формат <input type="date">) —
// показываем как привычное ДД.ММ.ГГГГ, без часового пояса (это календарная
// дата, а не момент времени, конвертировать её незачем).
export function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}.${month}.${year}`;
}
