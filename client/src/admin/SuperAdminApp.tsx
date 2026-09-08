import React, { useEffect, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import StickerPacksPanel from './StickerPacksPanel';
import EmojiCatalogPanel from './EmojiCatalogPanel';
import ReleaseRollbackPanel from './ReleaseRollbackPanel';
import SuperAdminLogin from './SuperAdminLogin';
import UsersPanel from './panels/UsersPanel';
import InternetUsersPanel from './panels/InternetUsersPanel';
import GroupsPanel from './panels/GroupsPanel';
import DepartmentsPanel from './panels/DepartmentsPanel';
import UpdateSchedulePanel from './panels/UpdateSchedulePanel';
import GoogleCalendarPanel from './panels/GoogleCalendarPanel';
import ReactionsPanel from './panels/ReactionsPanel';
import SelfChatPanel from './panels/SelfChatPanel';
import { Group, UserRow } from './types';

type Tab = 'users' | 'internet' | 'groups' | 'departments' | 'emoji' | 'stickers' | 'reactions' | 'selfchat' | 'google' | 'updates';

/**
 * Разделы панели — оглавлением слева, а не десятью вкладками в ряд.
 *
 * Десять плоских вкладок занимали всю ширину экрана и требовали перечитать
 * весь ряд, чтобы найти нужную: «Отделы» и «Реакции» стояли рядом, хотя не
 * имеют друг к другу отношения. Группы отвечают на вопрос «про что раздел» —
 * про людей, про то, что показывается в переписке, или про само приложение.
 *
 * Раскладка та же, что у настроек приложения: одно оглавление слева, один
 * раздел справа. Два разных способа устроить одно и то же в одном продукте —
 * это лишняя вещь, которую человеку приходится запоминать.
 */
const NAV_GROUPS: { label: string; items: { id: Tab; label: string }[] }[] = [
  {
    label: 'Люди',
    items: [
      { id: 'users', label: 'Сотрудники' },
      { id: 'internet', label: 'Интернет' },
      { id: 'groups', label: 'Группы' },
      { id: 'departments', label: 'Отделы' },
    ],
  },
  {
    label: 'Содержимое',
    items: [
      { id: 'emoji', label: 'Смайлики' },
      { id: 'stickers', label: 'Стикеры' },
      { id: 'reactions', label: 'Реакции' },
    ],
  },
  {
    label: 'Приложение',
    items: [
      { id: 'selfchat', label: 'Следы' },
      { id: 'google', label: 'Google Календарь' },
      { id: 'updates', label: 'Обновления' },
    ],
  },
];

/** Заголовок открытого раздела: на узком экране он же и кнопка возврата. */
const TAB_LABELS: Record<Tab, string> = NAV_GROUPS.reduce((acc, group) => {
  for (const item of group.items) acc[item.id] = item.label;
  return acc;
}, {} as Record<Tab, string>);

export default function SuperAdminApp() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('superadmin_token'));
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [departments, setDepartments] = useState<Group[]>([]);
  const [loadError, setLoadError] = useState('');
  /**
   * Открытый раздел. `null` — открыто оглавление, и это состояние существует
   * только ради узкого экрана: там оглавление и раздел два уровня, а не две
   * колонки. На широком оглавление видно всегда.
   */
  const [openTab, setOpenTab] = useState<Tab | null>(null);
  const tab: Tab = openTab || 'users';

  const load = async () => {
    try {
      const [groupsRes, usersRes, departmentsRes] = await Promise.all([
        superAdminApi.get('/superadmin/groups'),
        superAdminApi.get('/superadmin/users'),
        superAdminApi.get('/superadmin/departments'),
      ]);
      setGroups(groupsRes.data);
      setUsers(usersRes.data);
      setDepartments(departmentsRes.data);
      setLoadError('');
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        localStorage.removeItem('superadmin_token');
        setToken(null);
      } else {
        setLoadError('Не удалось загрузить данные');
      }
    }
  };

  useEffect(() => {
    if (token) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return <SuperAdminLogin onLogin={setToken} />;
  }

  const handleLogout = () => {
    localStorage.removeItem('superadmin_token');
    setToken(null);
  };

  const counters: Partial<Record<Tab, number>> = {
    users: users.filter((u) => u.account_type !== 'internet').length,
    internet: users.filter((u) => u.account_type === 'internet').length,
    groups: groups.length,
    departments: departments.length,
  };

  return (
    <div className="sa-shell">
      <header className="sa-header">
        <div className="brand-mark">
          <span className="roundel roundel-sm">М</span>
          <div className="word" style={{ fontSize: 15.5 }}>МирасЧат — панель управления</div>
        </div>
        <button type="button" className="sa-btn-ghost" onClick={handleLogout}>Выйти</button>
      </header>

      <div className={'sa-body' + (openTab ? ' is-section-open' : '')}>
        <nav className="sa-nav" aria-label="Разделы панели">
          {NAV_GROUPS.map((group) => (
            <div className="sa-nav-group" key={group.label}>
              <div className="sa-nav-title">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={'sa-nav-item' + (tab === item.id ? ' is-active' : '')}
                  aria-current={tab === item.id ? 'page' : undefined}
                  onClick={() => setOpenTab(item.id)}
                >
                  <span className="sa-nav-name">{item.label}</span>
                  {counters[item.id] !== undefined && (
                    <span className="sa-nav-count">{counters[item.id]}</span>
                  )}
                  <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="sa-main">
          {/* Возврат к оглавлению — только на узком экране, где оглавление
              ушло на предыдущий уровень. */}
          <button type="button" className="sa-main-back" onClick={() => setOpenTab(null)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
            {TAB_LABELS[tab]}
          </button>

          {loadError && <p className="form-error">{loadError}</p>}
          {tab === 'users' && <UsersPanel users={users} groups={groups} departments={departments} onChanged={load} />}
          {tab === 'internet' && <InternetUsersPanel users={users} groups={groups} departments={departments} onChanged={load} />}
          {tab === 'groups' && <GroupsPanel groups={groups} onChanged={load} />}
          {tab === 'departments' && <DepartmentsPanel departments={departments} onChanged={load} />}
          {tab === 'emoji' && <EmojiCatalogPanel />}
          {tab === 'stickers' && <StickerPacksPanel />}
          {tab === 'reactions' && <ReactionsPanel />}
          {tab === 'selfchat' && <SelfChatPanel />}
          {tab === 'google' && <GoogleCalendarPanel users={users} />}
          {tab === 'updates' && (
            <>
              <UpdateSchedulePanel />
              <ReleaseRollbackPanel />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
