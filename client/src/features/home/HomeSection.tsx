import React, { useEffect, useMemo, useState } from 'react';
import api from '@/shared/api/client';
import { fetchRange } from '@/features/calendar/api';
import { formatClock, instantOf, todayKey } from '@/features/calendar/dates';
import { CustomEmojiMap, renderTextWithEmoji } from '@/features/emoji/customEmoji';

// «Главная» — стартовый экран приложения.
//
// Это не витрина статистики: каждый блок здесь — точка перехода к работе.
// Число без перехода бессмысленно («18 непрочитанных» и что дальше?), поэтому
// у каждой карточки есть адрес, куда она ведёт.
//
// Блоки намеренно независимы друг от друга: у каждого свой источник и своё
// состояние загрузки. Дальше сюда добавятся упоминания, важные сообщения,
// закреплённое, последние пространства — и добавление блока не должно означать
// переписывание экрана.
//
// Отступления от макета редизайна, сделанные сознательно:
//
// 1. **Ничего не обрезается многоточием.** В макете обрезаны и подписи карточек
//    («7 непрочита…»), и названия событий («Организационна…»), хотя документ
//    концепции сам дважды запрещает это для важного текста. Здесь подписи
//    переносятся на вторую строку, а высоту задаёт содержимое.
// 2. **Полосы вкладок «Обзор / Календарь / Файлы» нет.** Вкладка обещает «тот
//    же экран, другой срез», а Календарь и Файлы — самостоятельные разделы со
//    своей навигацией: такая вкладка была бы ссылкой, притворяющейся вкладкой.
//    Входы в них остались отдельным блоком.
// 3. **Блока «упоминания» нет.** Упоминаний в приложении не существует — ни
//    разбора «@имя», ни счётчика. Показать в сводке заведомо пустую строку
//    значит соврать, а посчитать её нечем.

export interface HomeCalendarTarget {
  occurrenceId: string;
  startAt: number;
}

interface DayEvent {
  id: string;
  title: string;
  time: string;
  startAt: number;
  allDay: boolean;
  target: HomeCalendarTarget;
}

interface Props {
  displayName: string;
  /** Непрочитанное считает сам чат-раздел — там оно уже живое по сокету. */
  unreadTotal: number;
  /** Свой статус: показывается в шапке и оттуда же меняется. */
  status?: { emoji: string; label: string } | null;
  customEmoji?: CustomEmojiMap;
  onOpenStatus: () => void;
  onOpenChats: () => void;
  onOpenTasks: () => void;
  onOpenCalendar: () => void;
  onOpenCalendarEvent: (target: HomeCalendarTarget) => void;
  /**
   * Личное хранилище. На телефоне «Файлы» лежат за кнопкой «Ещё», и «Главная»
   * остаётся самым коротким входом туда.
   */
  onOpenFiles: () => void;
}

/** «1 задача / 2 задачи / 5 задач». */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

/**
 * «через 40 минут», «через 2 часа», «идёт сейчас».
 *
 * Сколько осталось — полезнее времени начала: время человек и так видит в
 * расписании рядом, а собираться он начинает от «сколько у меня есть».
 */
export function untilLabel(startAt: number, now: number): string {
  const minutes = Math.round((startAt - now) / 60000);
  if (minutes <= 0) return 'идёт сейчас';
  if (minutes < 60) return `через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `через ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  return 'сегодня';
}

interface StatTile {
  id: string;
  count: number;
  label: string;
  tone: 'chats' | 'tasks' | 'calendar';
  icon: React.ReactNode;
  onOpen: () => void;
}

const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ChevronRight = () => (
  <svg className="home-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const HomeSection: React.FC<Props> = ({
  displayName, unreadTotal, status, customEmoji = {}, onOpenStatus,
  onOpenChats, onOpenTasks, onOpenCalendar, onOpenCalendarEvent, onOpenFiles,
}) => {
  const [tasksCount, setTasksCount] = useState<number | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);
  // Расписание дня показывается СПИСКОМ, а не числом: «3 мероприятия» ничего не
  // говорит о том, к чему готовиться, — а именно за этим на «Главную» и
  // заходят утром.
  const [events, setEvents] = useState<DayEvent[] | null>(null);

  // Считаем по тем же ручкам, которыми живут сами разделы, а не по отдельной
  // сводке на сервере: у календаря правила видимости нетривиальные (общий
  // календарь, слои, дни рождения), и вторая их копия разъехалась бы с первой.
  useEffect(() => {
    let alive = true;

    api.get('/tasks')
      .then(({ data }) => {
        if (!alive) return;
        // «Назначенные мне» — то, что ещё нужно сделать. Завершённые в сводке
        // не нужны: это список дел, а не отчёт.
        const open = (data || []).filter((task: any) => task.status !== 'done');
        setTasksCount(open.length);
        const now = Date.now();
        setOverdueCount(open.filter((task: any) => task.due_at && task.due_at < now).length);
      })
      .catch(() => { if (alive) { setTasksCount(0); setOverdueCount(0); } });

    // Через общий fetchRange, а не своим запросом: правила видимости календаря
    // (общий/личный, слои, дни рождения) живут там, и вторая их копия здесь
    // разъехалась бы с самим разделом. Диапазон — сутки сегодняшнего дня в
    // миллисекундах, ровно как в самом календаре.
    const today = todayKey();
    fetchRange(instantOf(today, 0), instantOf(today, 24 * 60))
      .then((data) => {
        if (!alive) return;
        const all = [...data.events, ...data.birthdays].map((item: any) => {
          const startAt = item.starts_at ?? item.start_at ?? 0;
          const id = String(item.id ?? `${item.event_id ?? 'event'}:${item.occurrence_start ?? startAt}`);
          return {
            id,
            title: item.title || 'Без названия',
            // Событие на весь день времени не имеет — так и показываем.
            time: item.all_day ? 'весь день' : formatClock(startAt),
            startAt,
            allDay: !!item.all_day,
            target: { occurrenceId: id, startAt },
          };
        });
        all.sort((a, b) => a.startAt - b.startAt);
        setEvents(all);
      })
      .catch(() => { if (alive) setEvents([]); });

    return () => { alive = false; };
  }, []);

  // Плитки стоят ВСЕГДА, включая нули. Ноль — такой же ответ, как и любое
  // другое число: «на сегодня ничего не назначено» человек хочет видеть с утра
  // не меньше, чем «три задачи». Плюс ряд постоянного состава читается глазом
  // сразу, а прыгающий приходится каждый раз перечитывать.
  const tiles: StatTile[] = useMemo(() => [
    {
      id: 'unread',
      count: unreadTotal,
      label: plural(unreadTotal, 'непрочитанное сообщение', 'непрочитанных сообщения', 'непрочитанных сообщений'),
      tone: 'chats',
      icon: <svg {...stroke}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /></svg>,
      onOpen: onOpenChats,
    },
    {
      id: 'tasks',
      count: tasksCount ?? 0,
      label: plural(tasksCount ?? 0, 'задача в работе', 'задачи в работе', 'задач в работе'),
      tone: 'tasks',
      icon: <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></svg>,
      onOpen: onOpenTasks,
    },
    {
      id: 'events',
      count: events?.length ?? 0,
      label: plural(events?.length ?? 0, 'мероприятие сегодня', 'мероприятия сегодня', 'мероприятий сегодня'),
      tone: 'calendar',
      icon: <svg {...stroke}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 11h18" /></svg>,
      onOpen: onOpenCalendar,
    },
  ], [unreadTotal, tasksCount, events, onOpenChats, onOpenTasks, onOpenCalendar]);

  const now = Date.now();
  const nextEvent = (events || []).find((event) => !event.allDay && event.startAt > now);
  const today = new Date();

  return (
    <div className="home-section">
      <header className="home-hero">
        <div className="home-hero-copy">
          <p className="home-hero-date">
            {today.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="home-hero-greeting">{greeting(today)}, {displayName}!</h1>
        </div>
        <button
          type="button"
          className="home-status"
          onClick={onOpenStatus}
          title={status ? 'Изменить статус' : 'Установить статус'}
        >
          <span className={'home-status-dot' + (status ? ' is-busy' : '')} aria-hidden="true" />
          <span className="home-status-label">
            {status
              ? renderTextWithEmoji(`${status.emoji} ${status.label}`, customEmoji, 'home-status')
              : 'Я на связи'}
          </span>
          <svg className="home-status-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </header>

      <div className="home-stats">
        {tiles.map((tile) => (
          <button key={tile.id} type="button" className={'home-stat home-stat-' + tile.tone} onClick={tile.onOpen}>
            <span className="home-stat-icon" aria-hidden="true">{tile.icon}</span>
            <span className="home-stat-body">
              <span className="home-stat-count">{tile.count}</span>
              {/* Подпись переносится на вторую строку, а не обрезается: в
                  макете здесь стоит «7 непрочита…» — ровно то, что документ
                  концепции сам себе запрещает. */}
              <span className="home-stat-label">{tile.label}</span>
            </span>
            <ChevronRight />
          </button>
        ))}
      </div>

      <div className="home-columns">
        <section className="home-panel home-panel-schedule">
          <div className="home-panel-head">
            <div>
              <p className="home-eyebrow">Сегодня</p>
              <h2>Расписание</h2>
            </div>
            <button type="button" className="home-panel-link" onClick={onOpenCalendar}>
              Весь календарь
            </button>
          </div>
          {events === null && <p className="home-panel-note">Загрузка…</p>}
          {events !== null && events.length === 0 && (
            <p className="home-panel-note">На сегодня ничего не назначено.</p>
          )}
          {events !== null && events.length > 0 && (
            <ul className="home-schedule">
              {events.map((event) => (
                <li key={event.id}>
                  <button type="button" className="home-event" onClick={() => onOpenCalendarEvent(event.target)}>
                    <span className="home-event-time">{event.time}</span>
                    {/* Название переносится целиком: обрезанное «Экскурсия
                        «Хра…» не отличить от другой экскурсии, а переспросить
                        его в сводке не у кого. */}
                    <span className="home-event-title">{event.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="home-col-side">
          <section className="home-panel">
            <div className="home-panel-head">
              <div>
                <p className="home-eyebrow">Не потерять</p>
                <h2>Требует внимания</h2>
              </div>
            </div>
            {overdueCount > 0 ? (
              <button type="button" className="home-attention" onClick={onOpenTasks}>
                <span className="home-attention-icon" aria-hidden="true">
                  <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5l3 1.8" /></svg>
                </span>
                <span className="home-attention-body">
                  <span className="home-attention-title">
                    {overdueCount} {plural(overdueCount, 'задача просрочена', 'задачи просрочено', 'задач просрочено')}
                  </span>
                  <span className="home-attention-hint">Срок прошёл, статус не менялся</span>
                </span>
                <ChevronRight />
              </button>
            ) : (
              <p className="home-panel-note">Просроченного нет.</p>
            )}
          </section>

          {/* «Спокойный день» — не заглушка пустоты, а ответ на вопрос «сколько
              у меня есть»: время начала человек и так видит в расписании. */}
          <section className="home-panel home-next">
            <span className="home-next-mark" aria-hidden="true">
              <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5l3 1.8" /></svg>
            </span>
            <div className="home-next-copy">
              <p className="home-next-title">{nextEvent ? 'Ближайшее событие' : 'Спокойный день'}</p>
              <p className="home-next-hint">
                {nextEvent
                  ? `${nextEvent.title} — ${untilLabel(nextEvent.startAt, now)}`
                  : 'Больше сегодня ничего не запланировано'}
              </p>
            </div>
          </section>

          <section className="home-panel home-shortcuts">
            <div className="home-panel-head"><div><h2>Разделы</h2></div></div>
            <div className="home-links">
              <button type="button" className="home-link" onClick={onOpenCalendar}>Календарь</button>
              <button type="button" className="home-link" onClick={onOpenFiles}>Файлы</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default HomeSection;
