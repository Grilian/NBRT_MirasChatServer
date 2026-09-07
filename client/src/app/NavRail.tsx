import React from 'react';

// Разделы приложения. Список объявлен один раз и целиком — рельс рассчитан на
// финальный набор пунктов, чтобы навигацию не пришлось переделывать по мере
// появления самих разделов. У нереализованных стоит ready: false — они
// открываются, но показывают заглушку «В разработке» (см. SectionStub).
export type SectionId =
  | 'home'
  | 'chats'
  | 'people'
  | 'spaces'
  | 'calendar'
  | 'tasks'
  | 'documents'
  | 'settings';

export interface SectionMeta {
  id: SectionId;
  label: string;
  ready: boolean;
  /** Спокойный цвет иконки в десктопном рельсе. */
  tone: string;
  /** Чем раздел станет — текст заглушки для тех, что ещё не сделаны. */
  summary: string;
  icon: React.ReactNode;
}

const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// Цвета намеренно спокойные: задача — быстрее различать вкладки боковым
// зрением, а не превращать рельс в набор ярких кнопок.
export const SECTIONS: SectionMeta[] = [
  {
    id: 'home', label: 'Главная', ready: true, tone: '#6b9fd1',
    summary: 'Личная сводка: непрочитанное, задачи и мероприятия на сегодня.',
    icon: <svg {...stroke}><path d="m3 10.5 9-7 9 7" /><path d="M5 9.6V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.6" /><path d="M9.5 21v-6h5v6" /></svg>,
  },
  {
    id: 'chats', label: 'Чаты', ready: true, tone: '#5f9ec7',
    summary: 'Переписка с коллегами и общие рассылки.',
    icon: <svg {...stroke}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /></svg>,
  },
  {
    id: 'people', label: 'Контакты', ready: true, tone: '#6fa99a',
    summary: 'Справочник сотрудников с поиском по подразделениям.',
    icon: <svg {...stroke}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  },
  {
    id: 'spaces', label: 'Пространства', ready: false, tone: '#8b80bd',
    summary: 'Рабочие пространства подразделений и проектов: свои каналы, участники и общие файлы внутри одного контура.',
    icon: <svg {...stroke}><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>,
  },
  {
    id: 'calendar', label: 'Календарь', ready: true, tone: '#bf8a73',
    summary: 'Совещания и события подразделения: приглашения прямо из чата, напоминания и общий график занятости.',
    icon: <svg {...stroke}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 11h18" /></svg>,
  },
  {
    id: 'tasks', label: 'Задачи', ready: true, tone: '#769b71',
    summary: 'Поручения со сроками и причастными людьми — видит их только тот, кого позвали.',
    icon: <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></svg>,
  },
  {
    id: 'documents', label: 'Файлы', ready: true, tone: '#a58b68',
    summary: 'Ваши файлы из всех переписок: поиск, сортировка, занятое место и удаление.',
    icon: <svg {...stroke}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg>,
  },
  {
    id: 'settings', label: 'Настройки', ready: true, tone: '#7e8fa4',
    summary: 'Тема оформления, уведомления и профиль.',
    icon: <svg {...stroke}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></svg>,
  },
];

export function sectionById(id: SectionId): SectionMeta {
  return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
}

// Тип "Интернет" — самостоятельная регистрация с улицы, не сотрудник. Ему
// незачем видеть пространства, задачи и документы; календарь остаётся, но
// общий слой в нём и так фильтрует сервер.
const INTERNET_VISIBLE_SECTIONS: SectionId[] = ['home', 'chats', 'people', 'calendar', 'documents', 'settings'];

export function isSectionAllowedFor(accountType: string | undefined, id: SectionId): boolean {
  return accountType !== 'internet' || INTERNET_VISIBLE_SECTIONS.includes(id);
}

const MOBILE_SECTION_SET = new Set<SectionId>(['home', 'chats', 'people', 'tasks', 'settings']);

export function mobileSectionsFor(accountType: string | undefined): SectionId[] {
  return SECTIONS
    .filter((s) => MOBILE_SECTION_SET.has(s.id) && isSectionAllowedFor(accountType, s.id))
    .map((s) => s.id);
}

interface NavRailProps {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  unreadTotal: number;
  onOpenMenu: () => void;
  menuOpen?: boolean;
  accountType?: string;
}

const NavRail: React.FC<NavRailProps> = ({ active, onSelect, unreadTotal, onOpenMenu, menuOpen = false, accountType }) => {
  const sections = SECTIONS.filter((s) => isSectionAllowedFor(accountType, s.id));

  return (
    <nav className="nav-rail" aria-label="Разделы">
      <div className="rail-brand">
        <button
          type="button"
          className={'rail-menu-button' + (menuOpen ? ' is-open' : '')}
          onClick={onOpenMenu}
          aria-label="Открыть меню"
          aria-expanded={menuOpen}
          title="Меню"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>

      <div className="rail-items">
        {sections.map((section) => {
          const isActive = active === section.id;
          const badge = section.id === 'chats' ? unreadTotal : 0;
          return (
            <button
              key={section.id}
              type="button"
              className={'rail-item rail-item-' + section.id + (isActive ? ' is-active' : '')
                + (MOBILE_SECTION_SET.has(section.id) ? '' : ' rail-item-desktop-only')}
              style={{ ['--rail-tone' as string]: section.tone }}
              aria-current={isActive ? 'page' : undefined}
              title={section.label}
              onClick={() => onSelect(section.id)}
            >
              <span className="rail-icon">
                {section.icon}
                {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
              </span>
              <span className="rail-label">{section.label}</span>
              {!section.ready && <span className="rail-soon" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default NavRail;
