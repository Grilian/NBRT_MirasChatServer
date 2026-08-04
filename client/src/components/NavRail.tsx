import React from 'react';
import Avatar from './Avatar';
import { ThemePreference, applyThemePreference, getThemePreference } from '../utils/theme';

// Разделы приложения. Список объявлен один раз и целиком — рельс рассчитан на
// финальный набор пунктов, чтобы навигацию не пришлось переделывать по мере
// появления самих разделов. У нереализованных стоит ready: false — они
// открываются, но показывают заглушку «В разработке» (см. SectionStub).
export type SectionId =
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

// «Настройки» на узком экране скрыты из нижней панели (см. .rail-item-settings
// в theme.css) — семи пунктам там банально не хватает ширины без горизонтальной
// прокрутки. Точка входа переехала в шапку списка чатов (см. roster-settings-btn
// в ChatList), а на самом рельсе пункт остаётся только для десктопной
// вертикальной раскладки.
export const SECTIONS: SectionMeta[] = [
  {
    id: 'chats',
    label: 'Чаты',
    ready: true,
    summary: 'Переписка с коллегами и общие рассылки.',
    icon: (
      <svg {...stroke}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" /></svg>
    ),
  },
  {
    id: 'people',
    label: 'Люди',
    ready: true,
    summary: 'Справочник сотрудников с поиском по подразделениям.',
    icon: (
      <svg {...stroke}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
    ),
  },
  {
    id: 'spaces',
    label: 'Пространства',
    ready: false,
    summary:
      'Рабочие пространства подразделений и проектов: свои каналы, участники и общие файлы внутри одного контура.',
    icon: (
      <svg {...stroke}><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>
    ),
  },
  {
    id: 'calendar',
    label: 'Календарь',
    ready: true,
    summary:
      'Совещания и события подразделения: приглашения прямо из чата, напоминания и общий график занятости.',
    icon: (
      <svg {...stroke}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 11h18" /></svg>
    ),
  },
  {
    id: 'tasks',
    label: 'Задачи',
    ready: true,
    summary: 'Поручения со сроками и причастными людьми — видит их только тот, кого позвали.',
    icon: (
      <svg {...stroke}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></svg>
    ),
  },
  {
    id: 'documents',
    label: 'Документы',
    ready: false,
    summary:
      'Общее хранилище файлов: вложения из переписки собираются в одном месте, с поиском и версиями.',
    icon: (
      <svg {...stroke}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg>
    ),
  },
  {
    id: 'settings',
    label: 'Настройки',
    ready: true,
    summary: 'Тема оформления, уведомления и профиль.',
    icon: (
      <svg {...stroke}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" /></svg>
    ),
  },
];

export function sectionById(id: SectionId): SectionMeta {
  return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
}

// Следующая тема по кругу. «Системная» намеренно остаётся только в настройках:
// на рельсе нужен предсказуемый выключатель, а не три состояния, из которых
// два внешне неразличимы.
function nextTheme(current: ThemePreference): 'light' | 'dark' {
  const effectiveDark =
    current === 'dark' ||
    (current === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  return effectiveDark ? 'light' : 'dark';
}

// Тип "Интернет" — самостоятельная регистрация с улицы, не сотрудник. Ему
// незачем видеть пространства, задачи (поручения — это про рабочие
// обязанности) и документы; календарь остаётся, но общий слой в нём и так
// не показывает сервер (см. canSeeGlobalCalendar на бэкенде).
const INTERNET_VISIBLE_SECTIONS: SectionId[] = ['chats', 'people', 'calendar', 'settings'];

// Тот же отбор нужен и снаружи рельса: тип аккаунта могут сменить прямо во
// время сессии, и человек, стоящий в разделе, который ему больше не положен,
// должен быть с него уведён — сам пункт из рельса к этому моменту уже исчез.
export function isSectionAllowedFor(accountType: string | undefined, id: SectionId): boolean {
  return accountType !== 'internet' || INTERNET_VISIBLE_SECTIONS.includes(id);
}

interface NavRailProps {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  unreadTotal: number;
  username: string;
  avatarPath: string | null;
  online: boolean;
  onOpenProfile: () => void;
  accountType?: string;
}

const NavRail: React.FC<NavRailProps> = ({
  active, onSelect, unreadTotal, username, avatarPath, online, onOpenProfile, accountType
}) => {
  const sections = SECTIONS.filter((s) => isSectionAllowedFor(accountType, s.id));

  // Текущую тему читаем в момент клика, а не держим в состоянии: её же меняет
  // выпадающий список в настройках, и своя копия успела бы разойтись с тем,
  // что реально записано в localStorage.
  const handleThemeToggle = () => {
    applyThemePreference(nextTheme(getThemePreference()));
  };

  return (
    <nav className="nav-rail" aria-label="Разделы">
      <div className="rail-brand" aria-hidden="true">
        <span className="roundel">M</span>
      </div>

      <div className="rail-items">
        {sections.map((section) => {
          const isActive = active === section.id;
          const badge = section.id === 'chats' ? unreadTotal : 0;
          return (
            <button
              key={section.id}
              type="button"
              className={'rail-item' + (isActive ? ' is-active' : '') + (section.id === 'settings' ? ' rail-item-settings' : '')}
              aria-current={isActive ? 'page' : undefined}
              title={section.label}
              onClick={() => onSelect(section.id)}
            >
              <span className="rail-icon">
                {section.icon}
                {badge > 0 && (
                  <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>
                )}
              </span>
              <span className="rail-label">{section.label}</span>
              {!section.ready && <span className="rail-soon" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <div className="rail-foot">
        <button
          type="button"
          className="rail-theme"
          onClick={handleThemeToggle}
          title="Сменить тему"
          aria-label="Сменить тему"
        >
          <svg {...stroke} width="18" height="18"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
        </button>
        <button type="button" className="rail-account" onClick={onOpenProfile} title={username}>
          <Avatar name={username} avatarPath={avatarPath} size="sm" online={online} />
          <span className="rail-account-text">
            <span className="rail-account-name">{username}</span>
            <span className={'rail-account-status' + (online ? '' : ' is-offline')}>
              {online ? 'Онлайн' : 'Нет связи'}
            </span>
          </span>
        </button>
      </div>
    </nav>
  );
};

export default NavRail;
