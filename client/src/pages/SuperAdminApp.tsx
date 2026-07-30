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
  department_id: number | null;
  department_name: string | null;
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
    <div className="sa-card sa-card--compact">
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

// Тип/группа/отдел/роль/тишина — раньше пять колонок прямо в строке таблицы,
// из-за чего она не помещалась и разъезжалась по горизонтали. Здесь их место
// заняла одна кнопка «Изменить», а сами поля переехали в модалку — строка
// стала узкой, а правка осталась настолько же быстрой (каждое поле сохраняется
// сразу по onChange, отдельной кнопки «Сохранить» как и раньше нет).
function UserSettingsModal({
  user, groups, departments, onChange, onClose
}: {
  user: UserRow; groups: Group[]; departments: Group[];
  onChange: (id: number, patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card sa-user-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">{user.display_name || user.username}</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="sa-user-modal-body">
          <div className="user-info-field">
            <span className="user-info-label">Тип</span>
            <select value={user.account_type} onChange={(e) => onChange(user.id, { account_type: e.target.value })}>
              {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="user-info-field">
            <span className="user-info-label">Группа</span>
            <select
              value={user.group_id ?? ''}
              onChange={(e) => onChange(user.id, { group_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">—</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>

          {/* Отдел назначается только здесь: им приглашают на события, и
              возможность выставить его себе означала бы выданный себе
              доступ к чужим встречам. */}
          <div className="user-info-field">
            <span className="user-info-label">Отдел</span>
            <select
              value={user.department_id ?? ''}
              onChange={(e) => onChange(user.id, { department_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">—</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="user-info-field">
            <span className="user-info-label">Роль</span>
            <select value={user.role ?? ''} onChange={(e) => onChange(user.id, { role: e.target.value || null })}>
              <option value="">— не назначена —</option>
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="user-info-field">
            <span className="user-info-label">Тишина</span>
            <label className="switch">
              <input type="checkbox" checked={user.muted} onChange={(e) => onChange(user.id, { muted: e.target.checked })} />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

function UsersPanel({ users, groups, departments, onChanged }: { users: UserRow[]; groups: Group[]; departments: Group[]; onChanged: () => void }) {
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [settingsUserId, setSettingsUserId] = useState<number | null>(null);
  const settingsUser = users.find((u) => u.id === settingsUserId) || null;

  // Таблица растёт вместе со штатом — при паре сотен строк пролистывать её
  // без поиска до нужного человека уже неудобно.
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? users.filter((u) => (u.display_name || '').toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle))
    : users;

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
      <div className="sa-card-head">
        <h2>Пользователи <span className="sa-count">{filtered.length}</span></h2>
        <input
          type="text"
          className="sa-search"
          placeholder="Поиск по имени или логину"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="sa-table-wrap">
      <table className="sa-table sa-table-users">
        <thead>
          <tr>
            <th>Имя (логин)</th>
            <th>Настройки</th>
            <th>Пароль</th>
            <th>Версия</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr><td colSpan={5} className="sa-empty">Никого не найдено</td></tr>
          )}
          {filtered.map((u) => (
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
                  <span
                    className="sa-link sa-user-cell"
                    onClick={() => startRename(u)}
                    title={`${u.display_name || u.username} (${u.username})`}
                  >
                    {u.display_name || u.username} ({u.username})
                    {u.account_type === 'staff' && <span className="sa-verified-badge" title="Подтверждённая учётная запись">✓</span>}
                  </span>
                )}
              </td>
              <td>
                <button type="button" className="sa-btn-ghost" onClick={() => setSettingsUserId(u.id)}>
                  Изменить{u.muted && <span className="sa-muted-tag" title="Тишина включена">🔇</span>}
                </button>
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

      {settingsUser && (
        <UserSettingsModal
          user={settingsUser}
          groups={groups}
          departments={departments}
          onChange={update}
          onClose={() => setSettingsUserId(null)}
        />
      )}
    </div>
  );
}


// Отделы — тот же справочник, что и группы, но про структуру, а не про права.
// Группа даёт «Администрации» право писать в режиме тишины; отдел — просто
// место человека, и смешивать их нельзя.
function DepartmentsPanel({ departments, onChanged }: { departments: Group[]; onChanged: () => void }) {
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState('');

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await superAdminApi.post('/superadmin/departments', { name });
      setNewName('');
      setError('');
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось создать отдел');
    }
  };

  const saveRename = async (id: number) => {
    const name = editName.trim();
    if (!name) { setEditingId(null); return; }
    try {
      await superAdminApi.put(`/superadmin/departments/${id}`, { name });
      setEditingId(null);
      onChanged();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось переименовать');
    }
  };

  const remove = async (item: Group) => {
    const warning = item.member_count > 0
      ? `Удалить отдел «${item.name}»? У ${item.member_count} сотрудников он станет не указан.`
      : `Удалить отдел «${item.name}»?`;
    if (!window.confirm(warning)) return;
    await superAdminApi.delete(`/superadmin/departments/${item.id}`);
    onChanged();
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Отделы</h2>
      <p className="sa-hint">
        Из этого списка выбирают отдел в профиле; по нему же приглашают на события целыми отделами.
      </p>
      {error && <p className="form-error">{error}</p>}
      <table className="sa-table">
        <thead>
          <tr><th>Название</th><th>Сотрудников</th><th></th></tr>
        </thead>
        <tbody>
          {departments.map((item) => (
            <tr key={item.id}>
              <td>
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(item.id); if (e.key === 'Escape') setEditingId(null); }}
                    onBlur={() => saveRename(item.id)}
                  />
                ) : (
                  <span className="sa-link" onClick={() => { setEditingId(item.id); setEditName(item.name); }}>{item.name}</span>
                )}
              </td>
              <td>{item.member_count}</td>
              <td>
                <button type="button" className="sa-btn-danger" onClick={() => remove(item)}>Удалить</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={create} className="sa-inline-form">
        <input
          type="text"
          placeholder="Новый отдел…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="btn-primary">Добавить</button>
      </form>
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
    <div className="sa-card sa-card--compact">
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

type Tab = 'users' | 'groups' | 'departments' | 'updates';

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Пользователи' },
  { id: 'groups', label: 'Группы' },
  { id: 'departments', label: 'Отделы' },
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
          </button>
        ))}
      </nav>

      <main className="sa-main">
        {loadError && <p className="form-error">{loadError}</p>}
        {tab === 'users' && <UsersPanel users={users} groups={groups} departments={departments} onChanged={load} />}
        {tab === 'groups' && <GroupsPanel groups={groups} onChanged={load} />}
        {tab === 'departments' && <DepartmentsPanel departments={departments} onChanged={load} />}
        {tab === 'updates' && <UpdateSchedulePanel />}
      </main>
    </div>
  );
}
