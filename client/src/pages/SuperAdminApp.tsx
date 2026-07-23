import React, { useEffect, useState } from 'react';
import superAdminApi from '../api/superAdminClient';

interface Group {
  id: number;
  name: string;
  member_count: number;
}

interface UserRow {
  id: number;
  username: string;
  group_id: number | null;
  group_name: string | null;
  role: 'user' | 'moderator' | 'admin';
  muted: boolean;
  isMirror: boolean;
}

const ROLE_LABELS: Record<UserRow['role'], string> = {
  user: 'Сотрудник',
  moderator: 'Модератор',
  admin: 'Администратор',
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
  const [passwordForId, setPasswordForId] = useState<number | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
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

  const savePassword = async (id: number) => {
    const pw = passwordValue.trim();
    setPasswordForId(null);
    setPasswordValue('');
    if (!pw) return;
    if (pw.length < 6) { setError('Пароль должен быть не короче 6 символов'); return; }
    await update(id, { password: pw });
  };

  return (
    <div className="sa-card">
      <h2>Пользователи</h2>
      {error && <p className="form-error">{error}</p>}
      <table className="sa-table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Тип</th>
            <th>Группа</th>
            <th>Роль</th>
            <th>Тишина</th>
            <th>Пароль</th>
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
                  <span className="sa-link" onClick={() => startRename(u)}>{u.username}</span>
                )}
              </td>
              <td>
                {u.isMirror ? <span className="badge-admin">Зеркало МИРАС</span> : 'Сотрудник'}
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
                <select value={u.role} onChange={(e) => update(u.id, { role: e.target.value })}>
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
                {passwordForId === u.id ? (
                  <input
                    autoFocus
                    type="password"
                    placeholder="Новый пароль"
                    value={passwordValue}
                    onChange={(e) => setPasswordValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') savePassword(u.id); if (e.key === 'Escape') setPasswordForId(null); }}
                    onBlur={() => savePassword(u.id)}
                  />
                ) : (
                  <button type="button" className="sa-btn-ghost" onClick={() => { setPasswordForId(u.id); setPasswordValue(''); }}>
                    Сменить
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      </main>
    </div>
  );
}
