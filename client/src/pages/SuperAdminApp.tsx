import React, { useEffect, useState } from 'react';
import superAdminApi from '../api/superAdminClient';
import { AccountType, ACCOUNT_TYPE_LABELS, ROLE_LABELS } from '../utils/accountMeta';
import { formatMoscowDateTime, fromMoscowInputValue, toMoscowInputValue } from '../utils/time';

interface Group {
  id: number;
  name: string;
  member_count: number;
}

type PasswordStatus = 'ok' | 'pending' | 'expired';

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  group_id: number | null;
  group_name: string | null;
  role: 'user' | 'moderator' | 'admin' | null;
  muted: boolean;
  account_type: AccountType;
  password_status: PasswordStatus;
  /** Может отсутствовать, если панель открыта против сервера постарше. */
  app_versions?: AppVersion[];
}

interface AppVersion {
  platform: 'desktop' | 'android' | 'web';
  version: string;
  updated_at: number;
}

const PLATFORM_LABELS: Record<string, string> = {
  desktop: 'ПК',
  android: 'Android',
  web: 'Веб',
};

// Фиксированный порядок платформ: иначе строки таблицы перемешивались бы
// в зависимости от того, откуда человек заходил последним, и колонку стало бы
// невозможно читать сверху вниз.
const PLATFORM_ORDER = ['desktop', 'android', 'web'];

/**
 * Версии приложений у одного человека. Их может быть несколько: десктоп на
 * работе и телефон в кармане — это разные установки с разными версиями,
 * и при раскатке важно видеть обе.
 */
function AppVersions({ versions }: { versions?: AppVersion[] }) {
  if (!versions || versions.length === 0) {
    return (
      <span
        className="sa-version is-old"
        title="Клиент не сообщает версию: сборка старше этой возможности либо человек с тех пор не заходил"
      >
        old
      </span>
    );
  }

  const sorted = [...versions].sort(
    (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
  );

  return (
    <div className="sa-versions">
      {sorted.map((item) => (
        <span
          key={item.platform}
          className="sa-version"
          title={`Отчитался ${formatMoscowDateTime(item.updated_at)}`}
        >
          <span className="sa-version-platform">
            {PLATFORM_LABELS[item.platform] || item.platform}
          </span>
          {item.version}
        </span>
      ))}
    </div>
  );
}

const PASSWORD_STATUS_LABELS: Record<Exclude<PasswordStatus, 'ok'>, string> = {
  pending: 'Ждёт нового пароля',
  expired: 'Недействителен',
};

function SuperAdminLogin({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await superAdminApi.post('/superadmin/login', { username, password });
      localStorage.setItem('superadmin_token', data.token);
      onLogin(data.token);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand-mark">
          <span className="roundel">M</span>
          <div className="word">
            MirasChat
            <span className="sub">Панель управления</span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Логин</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>Пароль</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Входим…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}

function GroupsPanel({ groups, onChanged }: { groups: Group[]; onChanged: () => void }) {
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState('');

  const createGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await superAdminApi.post('/superadmin/groups', { name });
      setNewName('');
      setError('');
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось создать группу');
    }
  };

  const startRename = (g: Group) => {
    setEditingId(g.id);
    setEditName(g.name);
  };

  const saveRename = async (id: number) => {
    const name = editName.trim();
    if (!name) { setEditingId(null); return; }
    try {
      await superAdminApi.put(`/superadmin/groups/${id}`, { name });
      setEditingId(null);
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось переименовать');
    }
  };

  const deleteGroup = async (g: Group) => {
    if (!window.confirm(`Удалить группу «${g.name}»? Участники останутся без группы.`)) return;
    await superAdminApi.delete(`/superadmin/groups/${g.id}`);
    onChanged();
  };

  return (
    <div className="sa-card">
      <h2>Группы</h2>
      {error && <p className="form-error">{error}</p>}
      <table className="sa-table">
        <thead>
          <tr><th>Название</th><th>Участников</th><th></th></tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td>
                {editingId === g.id ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(g.id); if (e.key === 'Escape') setEditingId(null); }}
                    onBlur={() => saveRename(g.id)}
                  />
                ) : (
                  <span className="sa-link" onClick={() => startRename(g)}>{g.name}</span>
                )}
              </td>
              <td>{g.member_count}</td>
              <td>
                <button type="button" className="sa-btn-danger" onClick={() => deleteGroup(g)}>Удалить</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={createGroup} className="sa-inline-form">
        <input
          type="text"
          placeholder="Новая группа…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="btn-primary">Добавить</button>
      </form>
    </div>
  );
}

function UsersPanel({ users, groups, onChanged }: { users: UserRow[]; groups: Group[]; onChanged: () => void }) {
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');

  const update = async (id: number, patch: Record<string, unknown>) => {
    try {
      await superAdminApi.put(`/superadmin/users/${id}`, patch);
      setError('');
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  const startRename = (u: UserRow) => {
    setRenamingId(u.id);
    setRenameValue(u.username);
  };

  const saveRename = async (id: number) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    await update(id, { username: name });
  };

  const resetPassword = async (u: UserRow) => {
    if (!window.confirm(`Сбросить пароль для «${u.display_name || u.username}»? Старый пароль сразу перестанет действовать.`)) return;
    try {
      await superAdminApi.post(`/superadmin/users/${u.id}/reset-password`);
      setError('');
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сбросить пароль');
    }
  };

  const deleteUser = async (u: UserRow) => {
    if (!window.confirm(`Полностью удалить «${u.display_name || u.username}» вместе со всей перепиской? Переписка перед этим архивируется на диск сервера, но из приложения аккаунт исчезнет безвозвратно.`)) return;
    try {
      await superAdminApi.post(`/superadmin/users/${u.id}/delete`);
      setError('');
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось удалить аккаунт');
    }
  };

  return (
    <div className="sa-card">
      <h2>Пользователи</h2>
      {error && <p className="form-error">{error}</p>}
      <table className="sa-table">
        <thead>
          <tr>
            <th>Имя (Логин)</th>
            <th>Тип</th>
            <th>Группа</th>
            <th>Роль</th>
            <th>Тишина</th>
            <th>Пароль</th>
            <th>Версия</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.muted ? 'sa-row-muted' : ''}>
              <td>
                {renamingId === u.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(u.id); if (e.key === 'Escape') setRenamingId(null); }}
                    onBlur={() => saveRename(u.id)}
                  />
                ) : (
                  <span className="sa-link" onClick={() => startRename(u)}>
                    {u.display_name || u.username} ({u.username})
                    {u.account_type === 'staff' && <span className="sa-verified-badge" title="Подтверждённая учётная запись">✓</span>}
                  </span>
                )}
              </td>
              <td>
                <select value={u.account_type} onChange={(e) => update(u.id, { account_type: e.target.value })}>
                  {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={u.group_id ?? ''}
                  onChange={(e) => update(u.id, { group_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">—</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </td>
              <td>
                <select value={u.role ?? ''} onChange={(e) => update(u.id, { role: e.target.value || null })}>
                  <option value="">— не назначена —</option>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </td>
              <td>
                <label className="switch">
                  <input type="checkbox" checked={u.muted} onChange={(e) => update(u.id, { muted: e.target.checked })} />
                  <span className="switch-track"><span className="switch-thumb" /></span>
                </label>
              </td>
              <td>
                <button type="button" className="sa-btn-ghost" onClick={() => resetPassword(u)}>Сменить</button>
                {u.password_status !== 'ok' && (
                  <span className={'sa-password-status' + (u.password_status === 'expired' ? ' is-expired' : '')}>
                    {PASSWORD_STATUS_LABELS[u.password_status]}
                  </span>
                )}
              </td>
              <td>
                <AppVersions versions={u.app_versions} />
              </td>
              <td>
                <button type="button" className="sa-btn-danger" onClick={() => deleteUser(u)}>Удалить</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Момент, раньше которого клиенты не ставят скачанное обновление. Само
// обновление скачивается всё равно сразу — откладывается только установка:
// иначе в назначенный час все клиенты разом полезут на сервер за 80 МБ.
function UpdateSchedulePanel() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/superadmin/update-schedule');
      setSaved(data.notBefore ?? null);
      setValue(data.notBefore ? toMoscowInputValue(data.notBefore) : '');
    } catch {
      setError('Не удалось загрузить расписание');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const ms = fromMoscowInputValue(value);
    if (ms === null) {
      setError('Укажите дату и время');
      return;
    }
    try {
      const { data } = await superAdminApi.put('/superadmin/update-schedule', { notBefore: ms });
      setSaved(data.notBefore);
      setError('');
      setStatus('Сохранено');
    } catch {
      setError('Не удалось сохранить');
    }
  };

  const clear = async () => {
    try {
      await superAdminApi.put('/superadmin/update-schedule', { notBefore: null });
      setSaved(null);
      setValue('');
      setError('');
      setStatus('Обновления ставятся сразу');
    } catch {
      setError('Не удалось сохранить');
    }
  };

  return (
    <div className="sa-card">
      <h2>Обновления</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        {saved === null
          ? 'Время не задано — клиенты ставят новую версию сразу, как только она появится на сервере.'
          : `Ближайшая установка: ${formatMoscowDateTime(saved)} по Москве.`}
      </p>

      <p className="sa-hint">
        Время, назначенное раньше, чем залит билд, считается уже прошедшим — такая
        версия уедет клиентам сразу. Клиент, выключенный в назначенный час,
        обновится при следующем запуске.
      </p>

      <form onSubmit={save} className="sa-inline-form">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => { setValue(e.target.value); setStatus(''); }}
        />
        <button type="submit" className="btn-primary">Сохранить</button>
        <button type="button" className="sa-btn-ghost" onClick={clear}>Ставить сразу</button>
      </form>

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}

export default function SuperAdminApp() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('superadmin_token'));
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadError, setLoadError] = useState('');

  const load = async () => {
    try {
      const [groupsRes, usersRes] = await Promise.all([
        superAdminApi.get('/superadmin/groups'),
        superAdminApi.get('/superadmin/users'),
      ]);
      setGroups(groupsRes.data);
      setUsers(usersRes.data);
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

      <main className="sa-main">
        {loadError && <p className="form-error">{loadError}</p>}
        <GroupsPanel groups={groups} onChanged={load} />
        <UsersPanel users={users} groups={groups} onChanged={load} />
        <UpdateSchedulePanel />
      </main>
    </div>
  );
}
