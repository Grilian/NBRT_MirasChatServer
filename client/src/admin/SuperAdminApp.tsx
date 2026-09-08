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

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Пользователи' },
  { id: 'internet', label: 'Интернет' },
  { id: 'groups', label: 'Группы' },
  { id: 'departments', label: 'Отделы' },
  { id: 'emoji', label: 'Смайлики' },
  { id: 'stickers', label: 'Стикеры' },
  { id: 'reactions', label: 'Реакции' },
  { id: 'selfchat', label: 'Следы' },
  { id: 'google', label: 'Google Календарь' },
  { id: 'updates', label: 'Обновления' },
];

export default function SuperAdminApp() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('superadmin_token'));
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [departments, setDepartments] = useState<Group[]>([]);
  const [loadError, setLoadError] = useState('');
  // Вкладки вместо одной длинной страницы: таблица пользователей растёт и
  // сама по себе занимает экран целиком, а прокручивать её вперемешку с
  // тремя другими карточками неудобно — переключение держит взгляд на одном
  // разделе за раз.
  const [tab, setTab] = useState<Tab>('users');

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

  return (
    <div className="sa-shell">
      <header className="sa-header">
        <div className="brand-mark">
          <span className="roundel roundel-sm">M</span>
          <div className="word" style={{ fontSize: 15.5 }}>MirasChat — панель управления</div>
        </div>
        <button type="button" className="sa-btn-ghost" onClick={handleLogout}>Выйти</button>
      </header>

      <nav className="sa-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={'sa-tab' + (tab === t.id ? ' is-active' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'users' && <span className="sa-tab-count">{users.length}</span>}
            {t.id === 'internet' && (
              <span className="sa-tab-count">{users.filter((u) => u.account_type === 'internet').length}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="sa-main">
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
  );
}
