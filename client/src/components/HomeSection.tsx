import React, { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { fetchRange } from '../calendar/api';
import { instantOf, todayKey } from '../calendar/dates';

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

interface HomeCard {
  id: string;
  group: 'today' | 'attention';
  icon: string;
  count: number;
  /** «3 мероприятия» — с правильным окончанием. */
  label: string;
  hint?: string;
  onOpen: () => void;
}

interface Props {
  displayName: string;
  /** Непрочитанное считает сам чат-раздел — там оно уже живое по сокету. */
  unreadTotal: number;
  onOpenChats: () => void;
  onOpenTasks: () => void;
  onOpenCalendar: () => void;
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

const HomeSection: React.FC<Props> = ({
  displayName, unreadTotal, onOpenChats, onOpenTasks, onOpenCalendar,
}) => {
  const [tasksCount, setTasksCount] = useState<number | null>(null);
  const [eventsCount, setEventsCount] = useState<number | null>(null);

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
        setTasksCount((data || []).filter((task: any) => task.status !== 'done').length);
      })
      .catch(() => { if (alive) setTasksCount(0); });

    // Через общий fetchRange, а не своим запросом: правила видимости календаря
    // (общий/личный, слои, дни рождения) живут там, и вторая их копия здесь
    // разъехалась бы с самим разделом. Диапазон — сутки сегодняшнего дня в
    // миллисекундах, ровно как в самом календаре.
    const today = todayKey();
    fetchRange(instantOf(today, 0), instantOf(today, 24 * 60))
      .then((data) => {
        if (!alive) return;
        setEventsCount(data.events.length + data.birthdays.length);
      })
      .catch(() => { if (alive) setEventsCount(0); });

    return () => { alive = false; };
  }, []);

  const cards: HomeCard[] = useMemo(() => {
    const list: HomeCard[] = [];
    if (eventsCount !== null && eventsCount > 0) {
      list.push({
        id: 'events',
        group: 'today',
        icon: '📅',
        count: eventsCount,
        label: plural(eventsCount, 'мероприятие', 'мероприятия', 'мероприятий'),
        onOpen: onOpenCalendar,
      });
    }
    if (tasksCount !== null && tasksCount > 0) {
      list.push({
        id: 'tasks',
        group: 'today',
        icon: '☑️',
        count: tasksCount,
        label: plural(tasksCount, 'назначенная задача', 'назначенные задачи', 'назначенных задач'),
        onOpen: onOpenTasks,
      });
    }
    if (unreadTotal > 0) {
      list.push({
        id: 'unread',
        group: 'attention',
        icon: '💬',
        count: unreadTotal,
        label: plural(unreadTotal, 'непрочитанное сообщение', 'непрочитанных сообщения', 'непрочитанных сообщений'),
        onOpen: onOpenChats,
      });
    }
    return list;
  }, [eventsCount, tasksCount, unreadTotal, onOpenCalendar, onOpenTasks, onOpenChats]);

  const today = cards.filter((card) => card.group === 'today');
  const attention = cards.filter((card) => card.group === 'attention');
  const loading = tasksCount === null || eventsCount === null;

  const renderGroup = (title: string, group: HomeCard[]) => (
    group.length > 0 && (
      <section className="home-group">
        <h2>{title}</h2>
        <div className="home-cards">
          {group.map((card) => (
            <button key={card.id} type="button" className="home-card" onClick={card.onOpen}>
              <span className="home-card-icon" aria-hidden="true">{card.icon}</span>
              <span className="home-card-body">
                <span className="home-card-count">{card.count}</span>
                <span className="home-card-label">{card.label}</span>
              </span>
              <svg className="home-card-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ))}
        </div>
      </section>
    )
  );

  return (
    <div className="home-section">
      <header className="home-head">
        <h1>{greeting(new Date())}, {displayName}</h1>
        <p className="home-date">
          {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </header>

      {renderGroup('Сегодня', today)}
      {renderGroup('Требует внимания', attention)}

      {/* Пустое состояние — это не ошибка и не «нет данных»: это нормальный
          рабочий день, в котором ничего не горит. */}
      {!loading && cards.length === 0 && (
        <div className="home-empty">
          <span aria-hidden="true">✨</span>
          <p>Ничего не требует внимания: непрочитанного нет, задач на вас нет, мероприятий сегодня тоже.</p>
        </div>
      )}
      {loading && cards.length === 0 && <div className="home-empty">Загрузка…</div>}
    </div>
  );
};

export default HomeSection;
