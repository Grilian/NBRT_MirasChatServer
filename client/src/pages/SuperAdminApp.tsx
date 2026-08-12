import React, { useEffect, useState } from 'react';
import superAdminApi from '../api/superAdminClient';
import { AccountType, ACCOUNT_TYPE_LABELS, ROLE_LABELS } from '../utils/accountMeta';
import { formatMoscowDateTime, fromMoscowInputValue, toMoscowInputValue } from '../utils/time';
import { resolveUploadUrl } from '../utils/uploads';

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
  /** 'YYYY-MM-DD HH:MM:SS' от SQLite — по нему считается метка New. */
  created_at?: string | null;
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

function UsersPanel({ users, groups, departments, onChanged, newUserIds, embedded }: {
  users: UserRow[];
  groups: Group[];
  departments: Group[];
  onChanged: () => void;
  /** Кого пометить меткой New — считает вкладка «Интернет». */
  newUserIds?: number[];
  /** Внутри другой карточки: своя рамка и заголовок тогда не нужны. */
  embedded?: boolean;
}) {
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
    <div className={embedded ? '' : 'sa-card'}>
      <div className="sa-card-head">
        {!embedded && <h2>Пользователи <span className="sa-count">{filtered.length}</span></h2>}
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
                    {newUserIds?.includes(u.id) && <span className="sa-new-badge" title="Зарегистрировался с прошлого разбора">New</span>}
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

// Учётные записи с улицы. Их разбирают отдельно от сотрудников: подтвердить
// (сменить тип на «Сотрудник») или удалить. Метка New снимается со всех разом,
// когда админ уходит с вкладки — по условию «открыл и что-то сделал»: любое
// действие, включая переход на другую страницу, считается разбором.
function InternetUsersPanel({
  users, groups, departments, onChanged,
}: {
  users: UserRow[];
  groups: Group[];
  departments: Group[];
  onChanged: () => void;
}) {
  const [seenAt, setSeenAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    superAdminApi.get('/superadmin/internet-seen')
      .then(({ data }) => { if (!cancelled) setSeenAt(data.seenAt || 0); })
      .catch(() => { if (!cancelled) setSeenAt(0); });

    // Уход с вкладки = «разобрал». Отмечаем на размонтировании, а не по
    // таймеру: иначе метка снималась бы у человека, который просто открыл
    // вкладку и отошёл, не посмотрев список.
    return () => {
      cancelled = true;
      superAdminApi.put('/superadmin/internet-seen').catch(() => {});
    };
  }, []);

  const internetUsers = users.filter((u) => u.account_type === 'internet');

  // Пока не знаем момент последнего разбора — не мигаем метками: иначе при
  // каждом открытии вкладки на мгновение «новыми» выглядели бы все.
  const isNew = (user: UserRow) => {
    if (seenAt === null || !user.created_at) return false;
    const ms = Date.parse(user.created_at.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) && ms > seenAt;
  };

  const newCount = internetUsers.filter(isNew).length;

  return (
    <div className="sa-card">
      <h2>Интернет — {internetUsers.length}</h2>
      <p className="sa-hint">
        Регистрации с улицы. Они видят только других «Интернет» и группу «Админы»,
        пока их не подтвердят: смените тип на «Сотрудник» в колонке «Тип».
        {newCount > 0 && ` Новых с прошлого раза: ${newCount}.`}
      </p>

      {internetUsers.length === 0
        ? <p className="sa-hint">Пока никого.</p>
        : (
          <UsersPanel
            users={internetUsers}
            groups={groups}
            departments={departments}
            onChanged={onChanged}
            newUserIds={internetUsers.filter(isNew).map((u) => u.id)}
            embedded
          />
        )}
    </div>
  );
}

// Базовые реакции — короткий ряд, который предлагается над контекстным меню
// сообщения. Правится одним полем, как и пак смайликов: это набор строк, а не
// сущности со своими свойствами.
function ReactionsPanel() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/superadmin/reactions');
      setSaved(data.emoji);
      setValue(data.emoji.join(' '));
    } catch {
      setError('Не удалось загрузить реакции');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data } = await superAdminApi.put('/superadmin/reactions', { emoji: value });
      setSaved(data.emoji);
      setValue(data.emoji.join(' '));
      setError('');
      setStatus('Сохранено');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Реакции</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        Через пробел, до 12 штук — этот ряд человек видит над меню сообщения.
        Уже поставленные реакции набор не меняет: они останутся, даже если убрать
        эмодзи из списка. Пустое поле вернёт набор по умолчанию.
      </p>

      <div className="sa-reaction-preview">
        {saved.map((emoji) => <span key={emoji}>{emoji}</span>)}
      </div>

      <form onSubmit={save} className="sa-inline-form">
        <input
          type="text"
          value={value}
          placeholder="👍 ❤️ 😂"
          onChange={(e) => { setValue(e.target.value); setStatus(''); }}
        />
        <button type="submit" className="btn-primary">Сохранить</button>
      </form>

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}

// Личный чат «для себя» — заметки и пересылки. Настраивать тут пока нечего,
// кроме названия: сам чат существует у каждого по определению (chat_id вида
// self_<id>), заводить и удалять его нельзя.
function SelfChatPanel() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/superadmin/self-chat');
      setName(data.name);
      setSaved(data.name);
    } catch {
      setError('Не удалось загрузить название');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data } = await superAdminApi.put('/superadmin/self-chat', { name });
      setName(data.name);
      setSaved(data.name);
      setError('');
      setStatus('Сохранено');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Избранное / Облако / Архив</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        Это одна и та же сущность — личный чат, куда человек складывает заметки и
        пересылает сообщения. Видит его только владелец. Название общее для всех:
        сейчас — «{saved}».
      </p>

      <form onSubmit={save} className="sa-inline-form">
        <input
          type="text"
          value={name}
          maxLength={40}
          placeholder="Избранное"
          onChange={(e) => { setName(e.target.value); setStatus(''); }}
        />
        <button type="submit" className="btn-primary">Сохранить</button>
      </form>

      {status && <p className="sa-hint">{status}</p>}
    </div>
  );
}

interface EmojiCustomItem {
  id: number;
  name: string;
  file_path: string;
  fallback: string;
}

interface EmojiPack {
  id: number;
  name: string;
  enabled: boolean;
  emoji: string[];
  custom?: EmojiCustomItem[];
  // Убранные смайлики пака. Приезжают только в админской выдаче — в панели
  // выбора их нет и быть не может.
  retired_custom?: EmojiCustomItem[];
}

// Смайлик, чьё имя занято убранным: загрузка такого файла не проходит, но
// отказ поправимый — тот же смайлик можно вернуть, поставив ему эту картинку.
interface RetiredConflict {
  itemId: number;
  name: string;
  file: File;
}

const ARCHIVE_PACK_NAME = 'Архив смайликов';

// Смайлики хранятся текстом (юникод), а не картинками, поэтому пак правится
// одним полем: строка со смайликами через пробел. Это и «загрузить новый», и
// «отредактировать» одновременно — отдельного загрузчика файлов не нужно.
function EmojiPacksPanel() {
  const [packs, setPacks] = useState<EmojiPack[]>([]);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  // Файлы из последней загрузки, не прошедшие из-за убранного тёзки. Держим
  // вместе с File: вернуть смайлик мало, ему нужна та самая картинка, которую
  // человек уже выбрал — иначе пришлось бы просить её второй раз.
  const [conflicts, setConflicts] = useState<{ packId: number; items: RetiredConflict[] } | null>(null);

  const apply = (data: EmojiPack[]) => {
    setPacks(data);
    setDrafts(Object.fromEntries(data.map((p) => [p.id, p.emoji.join(' ')])));
  };

  const load = async () => {
    try {
      const { data } = await superAdminApi.get('/emoji/admin');
      apply(data);
      setError('');
    } catch {
      setError('Не удалось загрузить паки');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const { data } = await superAdminApi.post('/emoji/admin', { name, emoji: '' });
      apply(data);
      setNewName('');
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось создать пак');
    }
  };

  const update = async (id: number, patch: Record<string, unknown>) => {
    setSavingId(id);
    try {
      const { data } = await superAdminApi.put(`/emoji/admin/${id}`, patch);
      apply(data);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setSavingId(null);
    }
  };

  // Загрузка набором: имя выводится из имени файла, без вопроса на каждый —
  // набор из полусотни картинок иначе превращается в полсотни диалогов. Имя,
  // однажды выданное, больше не меняется: оно уезжает в тексты сообщений, и
  // переименование превратило бы их в мёртвые ссылки.
  const uploadCustom = async (packId: number, files: File[]) => {
    setSavingId(packId);
    const failed: string[] = [];
    const retired: RetiredConflict[] = [];
    let latest: EmojiPack[] | null = null;
    // Последовательно, а не пачкой: имена проверяются на уникальность в БД, и
    // параллельные загрузки одинаково названных файлов гонялись бы за именем.
    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
      const form = new FormData();
      form.append('image', file);
      form.append('name', name);
      try {
        const { data } = await superAdminApi.post(`/emoji/admin/${packId}/custom`, form);
        latest = data;
      } catch (err: any) {
        // Имя занято УБРАННЫМ смайликом — это не ошибка, а развилка: почти
        // всегда человек как раз и хотел обновить картинку, для чего сначала
        // убрал смайлик. Такие складываем отдельно и предлагаем вернуть.
        const data = err.response?.data;
        if (data?.code === 'name_retired' && data.itemId) {
          retired.push({ itemId: data.itemId, name, file });
        } else {
          // Один негодный файл не должен ронять всю пачку.
          failed.push(`${file.name}: ${data?.error || 'ошибка загрузки'}`);
        }
      }
    }
    if (latest) apply(latest);
    setConflicts(retired.length ? { packId, items: retired } : null);
    setError(failed.length ? `Не загружено (${failed.length}): ${failed.join('; ')}` : '');
    setSavingId(null);
  };

  // Вернуть убранный смайлик и сразу поставить ему картинку, которую человек
  // выбрал при неудавшейся загрузке. Два запроса, а не один: возврат и замена
  // картинки — разные операции и порознь тоже нужны.
  const restoreWithImage = async (packId: number, items: RetiredConflict[]) => {
    setSavingId(packId);
    const failed: string[] = [];
    for (const item of items) {
      try {
        await superAdminApi.put(`/emoji/admin/custom/${item.itemId}/restore`, { packId });
        const form = new FormData();
        form.append('image', item.file);
        await superAdminApi.post(`/emoji/admin/custom/${item.itemId}/image`, form);
      } catch (err: any) {
        failed.push(`:${item.name}: ${err.response?.data?.error || 'не удалось вернуть'}`);
      }
    }
    await load();
    setConflicts(null);
    setError(failed.length ? `Не вернулись (${failed.length}): ${failed.join('; ')}` : '');
    setSavingId(null);
  };

  // Возврат без замены картинки — для смайлика, убранного по ошибке. Пак нужен
  // отдельным доводом только для лежащих в архиве: он выключен, и возврат «на
  // место» оставил бы смайлик невидимым.
  const restoreCustom = async (itemId: number, packId: number) => {
    setSavingId(itemId);
    try {
      const { data } = await superAdminApi.put(`/emoji/admin/custom/${itemId}/restore`, { packId });
      apply(data);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось вернуть смайлик');
    } finally {
      setSavingId(null);
    }
  };

  const setFallback = async (itemId: number, fallback: string) => {
    try {
      const { data } = await superAdminApi.put(`/emoji/admin/custom/${itemId}`, { fallback });
      apply(data);
    } catch {
      setError('Не удалось сохранить базовый эмодзи');
    }
  };

  // Замена картинки под тем же :name: — код и старые сообщения не трогает,
  // меняется только то, что за кодом показывается.
  const replaceImage = async (itemId: number, file: File) => {
    const form = new FormData();
    form.append('image', file);
    setSavingId(itemId);
    try {
      const { data } = await superAdminApi.post(`/emoji/admin/custom/${itemId}/image`, form);
      apply(data);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось заменить картинку');
    } finally {
      setSavingId(null);
    }
  };

  // Порядок внутри пака — кнопками, а не перетаскиванием: список открывается
  // и на телефоне, а drag-and-drop там надёжно не ловится (см. заметки про
  // синтетический click после touchend в переписке). Меняем локально сразу,
  // для отклика, и следом отправляем весь порядок на сервер.
  const moveCustom = async (packId: number, itemId: number, direction: -1 | 1) => {
    const pack = packs.find((p) => p.id === packId);
    const list = pack?.custom;
    if (!list) return;
    const from = list.findIndex((i) => i.id === itemId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= list.length) return;

    const reordered = list.slice();
    [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
    setPacks((prev) => prev.map((p) => (p.id === packId ? { ...p, custom: reordered } : p)));

    try {
      const { data } = await superAdminApi.put(`/emoji/admin/${packId}/custom/reorder`, {
        order: reordered.map((i) => i.id),
      });
      apply(data);
    } catch {
      setError('Не удалось сохранить порядок');
      setPacks((prev) => prev.map((p) => (p.id === packId ? { ...p, custom: list } : p)));
    }
  };

  const removeCustom = async (itemId: number, name: string) => {
    if (!window.confirm(`Убрать смайлик :${name}: из панели выбора?\n\nВ уже отправленных сообщениях он останется картинкой. Вставлять в новые будет нельзя, но смайлик можно вернуть — он попадёт в «Убранные» внизу пака.`)) return;
    try {
      const { data } = await superAdminApi.delete(`/emoji/admin/custom/${itemId}`);
      apply(data);
    } catch {
      setError('Не удалось убрать смайлик');
    }
  };

  const remove = async (pack: EmojiPack) => {
    if (!window.confirm(`Удалить пак «${pack.name}» со всеми смайликами?`)) return;
    try {
      const { data } = await superAdminApi.delete(`/emoji/admin/${pack.id}`);
      apply(data);
    } catch {
      setError('Не удалось удалить пак');
    }
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Смайлики</h2>
      <p className="sa-hint">
        Пак — это вкладка в панели смайликов у сотрудников. Смайлики вводятся
        подряд, через пробел; выключенный пак в приложении не показывается.
        Картинки грузятся набором, имя берётся из имени файла. Убранный смайлик
        пропадает из панели выбора, но в уже отправленных сообщениях остаётся —
        и его можно вернуть. Чтобы поменять картинку, смайлик убирать не нужно:
        нажмите на неё прямо в плитке.
      </p>
      {error && <p className="form-error">{error}</p>}

      {packs.map((pack) => (
        <div key={pack.id} className="sa-emoji-pack">
          <div className="sa-emoji-pack-head">
            <input
              className="sa-emoji-pack-name"
              value={pack.name}
              onChange={(e) => setPacks((prev) => prev.map((p) => (p.id === pack.id ? { ...p, name: e.target.value } : p)))}
              onBlur={(e) => { if (e.target.value.trim() && e.target.value !== pack.name) update(pack.id, { name: e.target.value }); }}
            />
            <label className="switch" title={pack.enabled ? 'Показывается' : 'Скрыт'}>
              <input type="checkbox" checked={pack.enabled} onChange={(e) => update(pack.id, { enabled: e.target.checked })} />
              <span className="switch-track"><span className="switch-thumb" /></span>
            </label>
            <button type="button" className="sa-btn-danger" onClick={() => remove(pack)}>Удалить</button>
          </div>

          <textarea
            className="sa-emoji-input"
            rows={3}
            value={drafts[pack.id] ?? ''}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [pack.id]: e.target.value }))}
            placeholder="😀 😃 😄 …"
          />
          {/* Картиночные смайлики пака: сетка превью с удалением и кнопкой
              загрузки. Юникодные правятся полем выше — это два разных вида
              содержимого, и смешивать их в одном поле нечем. */}
          <div className="sa-emoji-custom">
            {pack.custom?.map((item, index) => (
              <div key={item.id} className="sa-emoji-custom-item" title={`:${item.name}:`}>
                <div className="sa-emoji-custom-order">
                  <button
                    type="button"
                    disabled={index === 0}
                    aria-label={`Сдвинуть :${item.name}: раньше`}
                    onClick={() => moveCustom(pack.id, item.id, -1)}
                  >‹</button>
                  <button
                    type="button"
                    disabled={index === (pack.custom?.length ?? 0) - 1}
                    aria-label={`Сдвинуть :${item.name}: позже`}
                    onClick={() => moveCustom(pack.id, item.id, 1)}
                  >›</button>
                </div>
                {/* Клик по картинке — замена файла под тем же :name:, а не
                    уборка смайлика: код и старые сообщения не меняются. */}
                <label className="sa-emoji-custom-image" title={`Заменить картинку :${item.name}:`}>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    disabled={savingId === item.id}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) replaceImage(item.id, file);
                    }}
                  />
                  <img src={resolveUploadUrl(item.file_path) || ''} alt={`:${item.name}:`} />
                  <span className="sa-emoji-custom-image-hint">{savingId === item.id ? '…' : 'заменить'}</span>
                </label>
                <span>:{item.name}:</span>
                {/* Базовый эмодзи — для мест, где картинку показать нечем:
                    уведомления ОС, буфер обмена, пропавший файл. */}
                <input
                  className="sa-emoji-fallback"
                  defaultValue={item.fallback}
                  placeholder="🙂"
                  maxLength={16}
                  title="Базовый эмодзи: подставляется в уведомлениях и при копировании"
                  onBlur={(e) => { if (e.target.value !== item.fallback) setFallback(item.id, e.target.value); }}
                />
                {/* Кнопка, а не клик по всей плитке: раньше попытка поправить
                    что-либо в плитке означала уборку смайлика. */}
                <button
                  type="button"
                  className="sa-emoji-custom-remove"
                  aria-label={`Убрать :${item.name}:`}
                  onClick={() => removeCustom(item.id, item.name)}
                >×</button>
              </div>
            ))}
            <label className="sa-emoji-custom-add">
              <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                disabled={savingId === pack.id}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = '';
                  if (files.length) uploadCustom(pack.id, files);
                }}
              />
              {savingId === pack.id ? 'Загрузка…' : '+ Картинками'}
            </label>
          </div>

          {/* Имя занято смайликом, который сами же и убрали: почти всегда это
              значит «хотел обновить картинку». Предлагаем ровно то действие,
              за которым человек и пришёл, вместо отказа с объяснением. */}
          {conflicts?.packId === pack.id && conflicts.items.length > 0 && (
            <div className="sa-emoji-conflict">
              <span>
                {conflicts.items.length === 1
                  ? `Смайлик :${conflicts.items[0].name}: убирали раньше.`
                  : `Убирали раньше: ${conflicts.items.map((i) => `:${i.name}:`).join(' ')}.`}
                {' '}Вернуть с новыми картинками?
              </span>
              <div className="sa-emoji-conflict-actions">
                <button
                  type="button"
                  disabled={savingId === pack.id}
                  onClick={() => restoreWithImage(pack.id, conflicts.items)}
                >
                  {savingId === pack.id ? 'Возвращаю…' : 'Вернуть'}
                </button>
                <button type="button" className="sa-btn-quiet" onClick={() => setConflicts(null)}>Не нужно</button>
              </div>
            </div>
          )}

          {/* Убранные смайлики пака. Показываем их приглушённо и отдельно от
              рабочих: в панель выбора они не попадают, но существуют — их имена
              заняты навсегда, и вернуть их можно только отсюда. */}
          {!!pack.retired_custom?.length && (
            <details className="sa-emoji-retired">
              <summary>Убранные: {pack.retired_custom.length}</summary>
              <div className="sa-emoji-retired-list">
                {pack.retired_custom.map((item) => (
                  <div key={item.id} className="sa-emoji-retired-item" title={`:${item.name}:`}>
                    <img src={resolveUploadUrl(item.file_path) || ''} alt={`:${item.name}:`} />
                    <span>:{item.name}:</span>
                    {/* Смайлики из удалённых паков лежат в архиве, а он выключен:
                        вернуть «на место» значило бы оставить невидимым, поэтому
                        для них спрашиваем живой пак. */}
                    {pack.name === ARCHIVE_PACK_NAME ? (
                      <select
                        defaultValue=""
                        disabled={savingId === item.id}
                        onChange={(e) => { if (e.target.value) restoreCustom(item.id, Number(e.target.value)); }}
                      >
                        <option value="" disabled>Вернуть в пак…</option>
                        {packs.filter((p) => p.name !== ARCHIVE_PACK_NAME).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    ) : (
                      <button
                        type="button"
                        disabled={savingId === item.id}
                        onClick={() => restoreCustom(item.id, pack.id)}
                      >
                        {savingId === item.id ? '…' : 'Вернуть'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="sa-emoji-pack-foot">
            <span className="sa-hint">
              {pack.emoji.length} шт.{pack.custom?.length ? ` + ${pack.custom.length} картинкой` : ''}
            </span>
            <button
              type="button"
              className="sa-btn-ghost"
              disabled={savingId === pack.id || (drafts[pack.id] ?? '') === pack.emoji.join(' ')}
              onClick={() => update(pack.id, { emoji: drafts[pack.id] ?? '' })}
            >
              {savingId === pack.id ? 'Сохраняем…' : 'Сохранить смайлики'}
            </button>
          </div>
        </div>
      ))}

      <form onSubmit={create} className="sa-inline-form">
        <input type="text" placeholder="Новый пак…" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="btn-primary">Добавить</button>
      </form>
    </div>
  );
}

type Tab = 'users' | 'internet' | 'groups' | 'departments' | 'emoji' | 'reactions' | 'selfchat' | 'updates';

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Пользователи' },
  { id: 'internet', label: 'Интернет' },
  { id: 'groups', label: 'Группы' },
  { id: 'departments', label: 'Отделы' },
  { id: 'emoji', label: 'Смайлики' },
  { id: 'reactions', label: 'Реакции' },
  { id: 'selfchat', label: 'Избранное' },
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
        {tab === 'emoji' && <EmojiPacksPanel />}
        {tab === 'reactions' && <ReactionsPanel />}
        {tab === 'selfchat' && <SelfChatPanel />}
        {tab === 'updates' && <UpdateSchedulePanel />}
      </main>
    </div>
  );
}
