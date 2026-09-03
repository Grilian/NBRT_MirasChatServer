import React, { useEffect, useRef, useState } from 'react';
import superAdminApi from '../api/superAdminClient';
import { AccountType, ACCOUNT_TYPE_LABELS, ROLE_LABELS } from '../utils/accountMeta';
import { formatMoscowDateTime, fromMoscowInputValue, toMoscowInputValue } from '../utils/time';
import { resolveUploadUrl } from '../utils/uploads';
import { useDragReorder } from '../utils/useDragReorder';
import StickerPacksPanel from '../components/StickerPacksPanel';
import ReleaseRollbackPanel from '../components/ReleaseRollbackPanel';
import EmojiPicker, { EmojiPack as PickerEmojiPack } from '../components/EmojiPicker';
import { CustomEmojiImage, DEFAULT_EMOJI_FALLBACK } from '../utils/customEmoji';
import { dismissLayerWithoutUnderlayActivation } from '../utils/dismissLayer';

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

// ===== Google Календарь =====

interface GoogleStatus {
  client_id: string;
  redirect_uri: string;
  has_secret: boolean;
  configured: boolean;
  scopes: string[];
  connected: boolean;
  email: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  owner_user_id: number | null;
  sync_from: number | null;
  last_sync_at: number | null;
  last_error: string | null;
  linked_count: number;
  readonly_count: number;
  sources: GoogleSource[];
}

interface GoogleCalendarOption {
  id: string;
  name: string;
  primary: boolean;
  access_role: string;
  writable: boolean;
}

/** Подключённый календарь: основной либо дополнительный, показываемый слоем. */
interface GoogleSource {
  id: number;
  google_calendar_id: string;
  name: string | null;
  color: string;
  access_role: string | null;
  read_only: number;
  is_main: number;
  last_error: string | null;
  linked_count: number;
}

// Та же палитра, что у событий календаря: цвет слоя выбирается из неё, чтобы
// дополнительный календарь отличался в сетке от общего и от личного.
const LAYER_COLORS: { value: string; label: string }[] = [
  { value: 'violet', label: 'Фиолетовый' },
  { value: 'teal', label: 'Бирюзовый' },
  { value: 'green', label: 'Зелёный' },
  { value: 'orange', label: 'Оранжевый' },
  { value: 'graphite', label: 'Графитовый' },
];

/**
 * Подключение гугл-аккаунта организации и настройки синхронизации.
 *
 * Аккаунт один на всех и синхронизируется с ОБЩИМ календарём: личные события
 * сотрудников в чужой гугл-аккаунт не уезжают. Подключение живёт в панели, а
 * не в профиле человека, именно поэтому — это настройка организации.
 */
function GoogleCalendarPanel({ users }: { users: UserRow[] }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [calendars, setCalendars] = useState<GoogleCalendarOption[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [newSourceId, setNewSourceId] = useState('');
  const [newSourceColor, setNewSourceColor] = useState('violet');

  const load = async () => {
    try {
      const { data } = await superAdminApi.get<GoogleStatus>('/calendar/google/admin/status');
      setStatus(data);
      setClientId(data.client_id);
      setRedirectUri(data.redirect_uri);
      setError('');
    } catch {
      setError('Не удалось загрузить настройки');
    }
  };

  useEffect(() => { load(); }, []);

  // Список календарей аккаунта нужен только после подключения и только один
  // раз: он ходит в Google, и дёргать его на каждый рендер панели незачем.
  useEffect(() => {
    if (!status?.connected) { setCalendars([]); return; }
    superAdminApi.get<GoogleCalendarOption[]>('/calendar/google/admin/calendars')
      .then(({ data }) => setCalendars(data))
      .catch((e) => setError(e.response?.data?.error || 'Не удалось получить список календарей'));
  }, [status?.connected, status?.email]);

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await superAdminApi.put('/calendar/google/admin/config', {
        client_id: clientId,
        // Пустое поле значит «не меняли»: секрет наружу не отдаётся и в форму
        // не подставляется, так что пустым оно выглядит и когда он задан.
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      });
      setClientSecret('');
      setNote('Сохранено');
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setError('');
    try {
      const { data } = await superAdminApi.get<{ url: string }>('/calendar/google/admin/auth-url');
      // Отдельным окном, а не переходом: панель — это несохранённая форма и
      // открытые вкладки, и уводить её на сторону Google ради одного согласия
      // значило бы вернуться на пустое место.
      const popup = window.open(data.url, 'google-oauth', 'width=520,height=680');
      if (!popup) {
        setError('Браузер заблокировал окно — разрешите всплывающие окна для этого адреса');
        return;
      }
      // Окно на чужом домене, и достучаться до него нельзя — единственный
      // доступный признак завершения — что его закрыли.
      const timer = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(timer);
        load();
      }, 800);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось начать подключение');
    }
  };

  const saveSettings = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await superAdminApi.put('/calendar/google/admin/settings', patch);
      setNote('Сохранено');
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const addSource = async () => {
    if (!newSourceId) return;
    const picked = calendars.find((c) => c.id === newSourceId);
    setBusy(true);
    try {
      await superAdminApi.post('/calendar/google/admin/sources', {
        calendar_id: newSourceId,
        name: picked?.name || newSourceId,
        color: newSourceColor,
      });
      setNewSourceId('');
      setNote('Календарь подключён. События приедут ближайшим обменом.');
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось подключить календарь');
    } finally {
      setBusy(false);
    }
  };

  const removeSource = async (source: GoogleSource) => {
    if (!window.confirm(
      `Отключить «${source.name || source.google_calendar_id}»? Его события удалятся из календаря чата — `
      + 'они были зеркалом и без источника обновлять их нечем. В самом Google ничего не изменится.'
    )) return;
    setBusy(true);
    try {
      const { data } = await superAdminApi.delete(`/calendar/google/admin/sources/${source.id}`);
      setNote(`Календарь отключён, событий убрано: ${data.removed_events}`);
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось отключить календарь');
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setNote('');
    try {
      const { data } = await superAdminApi.post('/calendar/google/admin/sync');
      setNote(data.skipped
        ? data.reason
        : `Отправлено: ${data.pushed}, удалено: ${data.deleted}, получено: ${data.pulled}`);
      setError('');
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Синхронизация не прошла');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(
      'Отключить аккаунт? Уже импортированные события останутся в общем календаре, '
      + 'но обмен изменениями прекратится.'
    )) return;
    setBusy(true);
    try {
      await superAdminApi.delete('/calendar/google/admin/connection');
      setNote('Аккаунт отключён');
      setError('');
      await load();
    } catch {
      setError('Не удалось отключить');
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="sa-card sa-card--compact"><p className="sa-hint">Загрузка…</p></div>;

  return (
    <div className="sa-google">
      {error && <p className="form-error">{error}</p>}
      {note && <p className="sa-hint">{note}</p>}

      <div className="sa-card sa-card--compact">
        <h2>Приложение Google</h2>
        <p className="sa-hint">
          В <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">консоли
          Google Cloud</a> включите Google Calendar API, создайте учётные данные OAuth типа
          «Web application» и впишите адрес возврата в её «Authorized redirect URIs» —
          дословно, как здесь.
        </p>

        <form onSubmit={saveConfig} className="sa-google-form">
          <label>
            <span>client_id</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="…apps.googleusercontent.com"
            />
          </label>
          <label>
            <span>client_secret {status.has_secret && <em>— задан</em>}</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={status.has_secret ? 'оставьте пустым, чтобы не менять' : ''}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Адрес возврата</span>
            <input
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="https://ваш-домен/miraschat/api/calendar/google/callback"
            />
          </label>
          <div className="sa-google-actions">
            <button type="submit" className="btn-primary" disabled={busy}>Сохранить</button>
          </div>
        </form>

        <p className="sa-hint">
          Запрашиваемые разрешения: календарь и адрес аккаунта. Ни почта, ни файлы не
          запрашиваются — это видно и в самом окне согласия.
        </p>
      </div>

      <div className="sa-card sa-card--compact">
        <h2>Аккаунт</h2>
        {status.connected ? (
          <>
            <p className="sa-hint">Подключён: <strong>{status.email || 'адрес неизвестен'}</strong></p>
            <div className="sa-google-actions">
              <button type="button" className="sa-btn-ghost" onClick={connect} disabled={busy}>
                Переподключить
              </button>
              <button type="button" className="sa-btn-danger" onClick={disconnect} disabled={busy}>
                Отключить
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sa-hint">
              {status.configured
                ? 'Откроется окно согласия Google. Входить нужно в тот аккаунт, чей календарь синхронизируем.'
                : 'Сначала заполните client_id, секрет и адрес возврата выше.'}
            </p>
            <button type="button" className="btn-primary" onClick={connect} disabled={!status.configured || busy}>
              Подключить Google
            </button>
          </>
        )}
      </div>

      {status.connected && (
        <div className="sa-card sa-card--compact">
          <h2>Что синхронизируем</h2>

          <label className="sa-google-field">
            <span>Календарь</span>
            <select
              value={status.calendar_id || ''}
              onChange={(e) => {
                const picked = calendars.find((c) => c.id === e.target.value);
                saveSettings({ calendar_id: e.target.value || null, calendar_name: picked?.name || null });
              }}
              disabled={busy || !calendars.length}
            >
              <option value="">— не выбран —</option>
              {calendars.filter((c) => c.writable).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (основной)' : ''}</option>
              ))}
            </select>
          </label>
          <p className="sa-hint">
            Сюда уезжают события, созданные в общем календаре чата, поэтому выбрать можно
            только календарь с правом записи. Его содержимое попадает в общий календарь,
            а не в отдельный слой. Смена сбрасывает связи и начинает обмен заново.
          </p>

          <label className="sa-google-field">
            <span>Автор импортированных событий</span>
            <select
              value={status.owner_user_id || ''}
              onChange={(e) => saveSettings({ owner_user_id: Number(e.target.value) || null })}
              disabled={busy}
            >
              <option value="">— не выбран —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
              ))}
            </select>
          </label>
          <p className="sa-hint">
            У события в нашем календаре обязан быть автор из числа сотрудников, а
            супер-админ панели — отдельная учётная запись, и её сюда не подставить.
            Правят общий календарь всё равно все администраторы, от выбора это не зависит.
          </p>

          <label className="sa-google-field">
            <span>Импортировать начиная с</span>
            <input
              type="datetime-local"
              value={status.sync_from ? toMoscowInputValue(status.sync_from) : ''}
              onChange={(e) => {
                const ms = fromMoscowInputValue(e.target.value);
                if (ms !== null) saveSettings({ sync_from: ms });
              }}
              disabled={busy}
            />
          </label>
          <p className="sa-hint">
            Всё, что в гугл-календаре раньше этого момента, не импортируется: в нём может
            лежать многолетний архив, которому в общем календаре не место.
          </p>
        </div>
      )}

      {status.connected && (
        <div className="sa-card sa-card--compact">
          <h2>Дополнительные календари</h2>
          <p className="sa-hint">
            Каждый показывается в календаре чата отдельным слоем со своим цветом — так же,
            как «Другие календари» в самом Google. Они только читаются: право записи для
            них не нужно, и события из чата в них не уезжают.
          </p>

          {status.sources.filter((s) => !s.is_main).length > 0 && (
            <ul className="sa-google-sources">
              {status.sources.filter((s) => !s.is_main).map((source) => (
                <li key={source.id}>
                  <span className={`sa-google-dot sa-google-dot--${source.color}`} />
                  <span className="sa-google-source-name">
                    {source.name || source.google_calendar_id}
                    <em>
                      {source.linked_count > 0
                        ? `событий: ${source.linked_count}`
                        : 'событий пока нет'}
                      {source.read_only ? '' : ', есть право записи'}
                    </em>
                    {source.last_error && <em className="form-error">{source.last_error}</em>}
                  </span>
                  <button
                    type="button"
                    className="sa-btn-danger"
                    onClick={() => removeSource(source)}
                    disabled={busy}
                  >
                    Отключить
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="sa-google-add">
            <select
              value={newSourceId}
              onChange={(e) => setNewSourceId(e.target.value)}
              disabled={busy || !calendars.length}
            >
              <option value="">— выберите календарь —</option>
              {calendars
                .filter((c) => c.id !== status.calendar_id)
                .filter((c) => !status.sources.some((s) => s.google_calendar_id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.writable ? '' : ' — только чтение'}
                  </option>
                ))}
            </select>
            <select
              value={newSourceColor}
              onChange={(e) => setNewSourceColor(e.target.value)}
              disabled={busy}
            >
              {LAYER_COLORS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn-primary"
              onClick={addSource}
              disabled={busy || !newSourceId}
            >
              Подключить
            </button>
          </div>
        </div>
      )}

      {status.connected && (
        <div className="sa-card sa-card--compact">
          <h2>Состояние</h2>
          <p className="sa-hint">
            {status.last_sync_at
              ? `Последний обмен: ${formatMoscowDateTime(status.last_sync_at)} по Москве.`
              : 'Обмена ещё не было.'}
            {' '}Связано событий: {status.linked_count}.
          </p>
          {status.readonly_count > 0 && (
            <p className="sa-hint">
              Из них {status.readonly_count} — только на чтение: у них правило повтора,
              которое наш календарь целиком не выражает (например, «второй вторник месяца»).
              Такие события мы показываем, но обратно в Google не отправляем, чтобы не
              переписать там настоящее правило нашим приближением.
            </p>
          )}
          {status.last_error && <p className="form-error">Последняя ошибка: {status.last_error}</p>}
          <div className="sa-google-actions">
            <button type="button" className="btn-primary" onClick={syncNow} disabled={busy}>
              Синхронизировать сейчас
            </button>
          </div>
          <p className="sa-hint">Сам по себе обмен идёт каждые пять минут.</p>
        </div>
      )}
    </div>
  );
}

// Базовые реакции выбираются из общей панели загруженных смайликов. В настройке
// хранится shortcode, а системный Unicode остаётся только запасным отображением.
function ReactionsPanel() {
  const [selected, setSelected] = useState<string[]>([]);
  const [packs, setPacks] = useState<EmojiPack[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const closeOutside = (event: Event) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      dismissLayerWithoutUnderlayActivation(event, () => setPickerOpen(false));
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('mousedown', closeOutside, true);
    window.addEventListener('touchstart', closeOutside, { capture: true, passive: false });
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('mousedown', closeOutside, true);
      window.removeEventListener('touchstart', closeOutside, true);
    };
  }, [pickerOpen]);

  const load = async () => {
    try {
      const [reactionsResponse, emojiResponse] = await Promise.all([
        superAdminApi.get('/superadmin/reactions'),
        superAdminApi.get('/emoji/admin'),
      ]);
      setSelected(reactionsResponse.data.emoji || []);
      setPacks(emojiResponse.data.packs || emojiResponse.data || []);
      setError('');
    } catch {
      setError('Не удалось загрузить реакции');
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data } = await superAdminApi.put('/superadmin/reactions', { emoji: selected });
      setSelected(data.emoji || []);
      setError('');
      setStatus('Сохранено');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  const pickerPacks: PickerEmojiPack[] = packs
    .filter((pack) => pack.enabled && (pack.custom || []).length > 0)
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      emoji: [],
      custom: pack.custom || [],
    }));

  const itemsByToken = new Map<string, EmojiCustomItem>();
  for (const pack of packs) {
    for (const item of pack.custom || []) {
      itemsByToken.set(`:${item.name}:`, item);
      if (item.unicode_key && item.unicode) itemsByToken.set(item.unicode, item);
    }
  }

  const toggle = (token: string) => {
    setStatus('');
    setSelected((current) => current.includes(token)
      ? current.filter((item) => item !== token)
      : [...current, token]);
  };

  return (
    <div className="sa-card sa-card--compact">
      <h2>Реакции</h2>
      {error && <p className="form-error">{error}</p>}

      <p className="sa-hint">
        Выберите загруженные смайлики, которые человек увидит над меню сообщения.
        Количество не ограничено. Уже поставленные реакции останутся, даже если
        убрать смайлик из этого списка.
      </p>

      <div className="sa-reaction-preview" aria-label="Выбранные реакции">
        {selected.length === 0 && <span className="sa-hint">Реакции пока не выбраны</span>}
        {selected.map((token) => {
          const item = itemsByToken.get(token);
          return (
            <button key={token} type="button" onClick={() => toggle(token)} title="Убрать реакцию">
              {item
                ? <CustomEmojiImage filePath={item.file_path} fallback={item.fallback || DEFAULT_EMOJI_FALLBACK} />
                : token}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="sa-reaction-picker-toggle"
        onClick={() => setPickerOpen((open) => !open)}
      >
        {pickerOpen ? 'Закрыть смайлики' : 'Выбрать смайлики'}
      </button>

      {pickerOpen && (
        <div className="sa-reaction-picker" ref={pickerRef}>
          <EmojiPicker
            embedded
            packsOverride={pickerPacks}
            selectedCustomEmoji={selected}
            onClose={() => setPickerOpen(false)}
            onPick={(picked) => {
              if (typeof picked !== 'string') toggle(picked.token || `:${picked.name}:`);
            }}
          />
        </div>
      )}

      <form onSubmit={save} className="sa-reaction-save">
        <span className="sa-hint">Выбрано: {selected.length}</span>
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
  animated_path?: string | null;
  fallback: string;
  unicode?: string | null;
  unicode_key?: string | null;
  label?: string;
  keywords?: string;
}

/**
 * Элемент пака в панели админа. Вид определяется по `file_path`: есть картинка —
 * картиночный смайлик (в сообщение уезжает код `:name:`), нет — юникодный (в
 * сообщение уезжает сам символ `emoji`). Оба показываются одинаковыми карточками
 * в одном списке, и порядок у них общий.
 */
interface EmojiItem {
  id: number;
  name: string;
  emoji: string;
  file_path: string | null;
  animated_path: string | null;
  fallback: string;
  unicode?: string | null;
  unicode_key?: string | null;
  label?: string;
  keywords?: string;
}

interface EmojiPack {
  id: number;
  name: string;
  enabled: boolean;
  emoji: string[];
  custom?: EmojiCustomItem[];
  // Полный список элементов пака — только в админской выдаче.
  items?: EmojiItem[];
}

interface EmojiAssetPack {
  id: number;
  key: string;
  name: string;
  role: 'base' | 'animation';
  enabled: boolean;
  active: boolean;
  item_count: number;
}

interface EmojiSystemState {
  assetPacks: EmojiAssetPack[];
  structure: { item_count: number; group_count: number };
  logicalItems: number;
}

const EMOJI_ASSET_ROLE_LABEL = { base: 'Базовое оформление', animation: 'Анимация' } as const;

// Имена файлам дают по коду эмодзи (`u_1f4a2`), поэтому базовый смайл почти
// всегда выводится из имени. Тот же разбор, что и на сервере (routes/emoji.js).
const fallbackFromName = (name: string): string => {
  const m = /^u_([0-9a-f_]+)$/.exec(name || '');
  if (!m) return '';
  const points = m[1].split('_').filter(Boolean).map((p) => parseInt(p, 16));
  if (!points.length || points.some((p) => !Number.isFinite(p) || p < 0x80 || p > 0x10ffff)) return '';
  try {
    return String.fromCodePoint(...points);
  } catch {
    return '';
  }
};

// Смайлики хранятся текстом (юникод), а не картинками, поэтому пак правится
// одним полем: строка со смайликами через пробел. Это и «загрузить новый», и
// «отредактировать» одновременно — отдельного загрузчика файлов не нужно.
/**
 * Карточка одного смайлика — всё, что им можно править. Вынесена в модалку
 * намеренно: в списке у карточки остаются только картинка и имя, иначе полсотни
 * плиток с полями внутри превращают экран в кашу, а искать в нём нужное
 * невозможно.
 */
function EmojiItemModal({
  item, onClose, onApply, onError,
}: {
  item: EmojiItem;
  onClose: () => void;
  onApply: (data: EmojiPack[]) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [fallback, setFallback] = useState(item.fallback);
  const [emoji, setEmoji] = useState(item.emoji);
  const [usage, setUsage] = useState<number | null>(null);
  const isImage = !!item.file_path;
  const derived = fallbackFromName(item.name);

  // Сколько сообщений уже содержит код — спрашиваем сразу при открытии, чтобы
  // к моменту нажатия «Удалить» цена решения была на экране, а не после него.
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    superAdminApi.get(`/emoji/admin/custom/${item.id}/usage`)
      .then(({ data }) => { if (alive) setUsage(data.count); })
      .catch(() => { if (alive) setUsage(null); });
    return () => { alive = false; };
  }, [item.id, isImage]);

  const run = async (label: string, fn: () => Promise<{ data: EmojiPack[] }>) => {
    setBusy(label);
    try {
      const { data } = await fn();
      onApply(data);
    } catch (err: any) {
      onError(err.response?.data?.error || 'Не удалось сохранить');
    } finally {
      setBusy('');
    }
  };

  const uploadImage = (file: File, kind: 'static' | 'animated') => {
    const form = new FormData();
    form.append('image', file);
    form.append('kind', kind);
    return run(kind, () => superAdminApi.post(`/emoji/admin/custom/${item.id}/image`, form));
  };

  const remove = async () => {
    const used = usage
      ? `\n\nКод :${item.name}: встречается в ${usage} уже отправленных сообщениях — там вместо картинки останется текст.`
      : '';
    const what = isImage ? `:${item.name}:` : item.emoji;
    if (!window.confirm(`Удалить ${what} навсегда?${used}\n\nФайлы будут стёрты с диска, имя освободится.`)) return;
    await run('delete', () => superAdminApi.delete(`/emoji/admin/custom/${item.id}`));
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card sa-emoji-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-emoji-modal-head">
          <h3>{isImage ? `:${item.name}:` : 'Смайлик'}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        {isImage ? (
          <>
            <label className="sa-emoji-modal-row">
              <span>Имя</span>
              {/* Только для чтения: имя уже уехало в тексты отправленных
                  сообщений, и переименование превратило бы их в мёртвые коды. */}
              <input value={`:${item.name}:`} readOnly title="Имя неизменяемо: оно хранится в текстах сообщений" />
            </label>

            <label className="sa-emoji-modal-row">
              <span>Базовый смайл</span>
              <input
                value={fallback}
                placeholder={derived || '🙂'}
                maxLength={16}
                onChange={(e) => setFallback(e.target.value)}
                onBlur={() => {
                  if (fallback !== item.fallback) {
                    run('fallback', () => superAdminApi.put(`/emoji/admin/custom/${item.id}`, { fallback }));
                  }
                }}
              />
            </label>
            <p className="sa-hint">
              Показывается там, где картинку не вставить: уведомления, копирование текста.
              {derived && !fallback && ` Выведен из имени: ${derived}`}
            </p>

            <div className="sa-emoji-modal-images">
              <div className="sa-emoji-modal-image">
                <span>Изображение</span>
                <img src={resolveUploadUrl(item.file_path) || ''} alt={`:${item.name}:`} />
                <label className="sa-btn-ghost">
                  <input
                    type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) uploadImage(f, 'static');
                    }}
                  />
                  {busy === 'static' ? '…' : 'Заменить'}
                </label>
              </div>

              {/* Анимация — поверх статичной, а не вместо неё: в панели выбора
                  всегда показывается статичная, иначе выбрать из десятка
                  дёргающихся картинок невозможно. */}
              <div className="sa-emoji-modal-image">
                <span>Анимация</span>
                {item.animated_path ? (
                  <img src={resolveUploadUrl(item.animated_path) || ''} alt="анимация" />
                ) : (
                  <div className="sa-emoji-modal-empty">нет</div>
                )}
                <label className="sa-btn-ghost">
                  <input
                    type="file" accept="image/gif,image/webp,image/png" style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) uploadImage(f, 'animated');
                    }}
                  />
                  {busy === 'animated' ? '…' : item.animated_path ? 'Заменить' : 'Загрузить'}
                </label>
                {item.animated_path && (
                  <button
                    type="button" className="sa-btn-quiet"
                    onClick={() => run('drop', () => superAdminApi.delete(`/emoji/admin/custom/${item.id}/animated`))}
                  >
                    Убрать анимацию
                  </button>
                )}
              </div>
            </div>
            <p className="sa-hint">
              В панели выбора всегда показывается статичная версия. Анимация видна только
              в переписке — и только тем, кто не выключил её у себя в настройках.
            </p>
          </>
        ) : (
          <>
            <label className="sa-emoji-modal-row">
              <span>Смайлик</span>
              <input
                value={emoji}
                maxLength={32}
                onChange={(e) => setEmoji(e.target.value)}
                onBlur={() => {
                  if (emoji.trim() && emoji !== item.emoji) {
                    run('emoji', () => superAdminApi.put(`/emoji/admin/custom/${item.id}`, { emoji }));
                  }
                }}
              />
            </label>
            <p className="sa-hint">
              Без картинки это обычный системный смайлик: в сообщение уезжает сам символ,
              поэтому удаление такого элемента старую переписку не затрагивает.
            </p>
          </>
        )}

        <div className="sa-emoji-modal-foot">
          <button type="button" className="sa-btn-danger" disabled={!!busy} onClick={remove}>
            {busy === 'delete' ? 'Удаляем…' : 'Удалить навсегда'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Экран «Смайлики». Паки — аккордеон: их немного, но в каждом сотни картинок, и
 * развёрнутые разом они не помещаются никуда. Открыт всегда один.
 */
function EmojiPacksPanel() {
  const [packs, setPacks] = useState<EmojiPack[]>([]);
  const [system, setSystem] = useState<EmojiSystemState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newName, setNewName] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);
  const [openPack, setOpenPack] = useState<number | null>(null);
  const [editing, setEditing] = useState<EmojiItem | null>(null);
  const [newEmoji, setNewEmoji] = useState('');
  const [assetPreset, setAssetPreset] = useState<'apple' | 'animation' | 'google-fonts'>('apple');
  const [systemBusy, setSystemBusy] = useState('');

  const apply = (data: EmojiPack[]) => {
    setPacks(data);
    // Открытая модалка должна показывать свежие данные (после замены картинки
    // или анимации), а не то, с чем её открыли.
    setEditing((prev) => (prev ? data.flatMap((p) => p.items || []).find((i) => i.id === prev.id) || null : null));
  };

  const load = async () => {
    try {
      const [packsResponse, systemResponse] = await Promise.all([
        superAdminApi.get('/emoji/admin'),
        superAdminApi.get('/emoji/admin/system'),
      ]);
      apply(packsResponse.data);
      setSystem(systemResponse.data);
      setError('');
    } catch {
      setError('Не удалось загрузить паки');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const importAssetArchive = async (file: File) => {
    const preset = {
      apple: { key: 'apple', name: 'Apple', role: 'base' },
      animation: { key: 'animation', name: 'Telegram Animation', role: 'animation' },
      'google-fonts': { key: 'google-fonts', name: 'Google Fonts', role: 'base' },
    }[assetPreset];
    setSystemBusy('assets');
    setError('');
    setNotice(`Загружаем ${preset.name}… Большой архив может обрабатываться несколько минут.`);
    const form = new FormData();
    form.append('archive', file);
    form.append('key', preset.key);
    form.append('name', preset.name);
    form.append('role', preset.role);
    try {
      const { data } = await superAdminApi.post('/emoji/admin/assets/import', form, { timeout: 30 * 60 * 1000 });
      apply(data.packs);
      await load();
      const report = data.report;
      setNotice(`Готово: ${report.imported} из ${report.total}. Пропущено: ${report.skipped}.`);
      if (report.errors?.length) setError(report.errors.join('; '));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось импортировать набор');
      setNotice('');
    } finally {
      setSystemBusy('');
    }
  };

  const importStructure = async (file: File) => {
    setSystemBusy('structure');
    setError('');
    const form = new FormData();
    form.append('structure', file);
    try {
      const { data } = await superAdminApi.post('/emoji/admin/structure', form);
      apply(data.packs);
      await load();
      setNotice(`Структура применена: ${data.report.item_count} эмодзи, ${data.report.group_count} разделов.`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось применить структуру');
    } finally {
      setSystemBusy('');
    }
  };

  const activateAssetPack = async (pack: EmojiAssetPack) => {
    setSystemBusy(`pack-${pack.id}`);
    try {
      await superAdminApi.put(`/emoji/admin/assets/${pack.id}`, { active: true });
      await load();
      setNotice(`Активный набор: ${pack.name}.`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось переключить набор');
    } finally {
      setSystemBusy('');
    }
  };

  // Раньше удалить загруженный ZIP-набор было нельзя вовсе — только
  // переключить активный. «Используется»/«Выбрать» на карточке многие читали
  // как блокировку удаления, хотя это просто индикатор активности.
  const deleteAssetPack = async (pack: EmojiAssetPack) => {
    if (!window.confirm(
      `Удалить набор «${pack.name}»?\n\nВсе ${pack.item_count} картинок этого набора будут стёрты с диска. `
      + 'Сами смайлики (Unicode-каталог) останутся — просто без этого оформления, если для них не '
      + 'загружен другой включённый набор той же роли.',
    )) return;
    setSystemBusy(`delete-pack-${pack.id}`);
    try {
      await superAdminApi.delete(`/emoji/admin/assets/${pack.id}`);
      await load();
      setNotice(`Набор «${pack.name}» удалён.`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось удалить набор');
    } finally {
      setSystemBusy('');
    }
  };

  const migrateOldUnicodeTokens = async () => {
    if (!window.confirm('Заменить старые коды :u_...: в сообщениях обычными Unicode-эмодзи?')) return;
    setSystemBusy('migrate');
    try {
      const { data } = await superAdminApi.post('/emoji/admin/migrate-unicode-tokens');
      setNotice(`Миграция завершена: обновлено сообщений — ${data.changed}.`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось выполнить миграцию');
    } finally {
      setSystemBusy('');
    }
  };

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
  // набор из полусотни картинок иначе превращается в полсотни диалогов.
  const uploadCustom = async (packId: number, files: File[]) => {
    setSavingId(packId);
    const failed: string[] = [];
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
        failed.push(`${file.name}: ${err.response?.data?.error || 'ошибка загрузки'}`);
      }
    }
    if (latest) apply(latest);
    setError(failed.length ? `Не загружено (${failed.length}): ${failed.join('; ')}` : '');
    setSavingId(null);
  };

  const addUnicode = async (packId: number) => {
    const emoji = newEmoji.trim();
    if (!emoji) return;
    setSavingId(packId);
    try {
      const { data } = await superAdminApi.post(`/emoji/admin/${packId}/unicode`, { emoji });
      apply(data);
      setNewEmoji('');
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось добавить');
    } finally {
      setSavingId(null);
    }
  };

  const removePack = async (pack: EmojiPack) => {
    if (!window.confirm(`Удалить пак «${pack.name}» со всеми смайликами?`)) return;
    try {
      const { data } = await superAdminApi.delete(`/emoji/admin/${pack.id}`);
      apply(data);
    } catch {
      setError('Не удалось удалить пак');
    }
  };

  const saveOrder = async (packId: number, order: number[]) => {
    try {
      const { data } = await superAdminApi.put(`/emoji/admin/${packId}/custom/reorder`, { order });
      apply(data);
    } catch {
      setError('Не удалось сохранить порядок');
      load();
    }
  };

  const savePackOrder = async (order: number[]) => {
    try {
      const { data } = await superAdminApi.put('/emoji/admin/reorder', { order });
      apply(data);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить порядок паков');
      void load();
    }
  };

  const {
    order: packOrder,
    dragId: draggedPackId,
    containerRef: packListRef,
    tileHandlers: packDragHandlers,
  } = useDragReorder({
    items: packs,
    onReorder: savePackOrder,
    dataAttribute: 'data-emoji-pack-id',
  });

  return (
    <div className="sa-card sa-card--compact">
      <h2>Смайлики</h2>
      <p className="sa-hint">
        Сообщение хранит обычный Unicode. Apple, Telegram Animation и Google Fonts —
        разные изображения одного смайлика; категории и порядок задаются отдельной структурой.
      </p>
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="sa-emoji-notice">{notice}</p>}

      <section className="sa-emoji-system">
        <div className="sa-emoji-system-block">
          <h3>1. Наборы изображений</h3>
          <p className="sa-hint">
            Один ZIP — один набор. Имена внутри: U+1F600.webp или U+1F1E6-U+1F1E8.webp.
            Все изображения сервер приводит к WebP; анимация сохраняет кадры.
          </p>
          <div className="sa-emoji-import-row">
            <select value={assetPreset} onChange={(e) => setAssetPreset(e.target.value as typeof assetPreset)}>
              <option value="apple">Apple — основной</option>
              <option value="animation">Telegram — анимация</option>
              <option value="google-fonts">Google Fonts — альтернативный</option>
            </select>
            <label className="sa-btn-ghost">
              <input
                type="file" accept=".zip,application/zip" style={{ display: 'none' }}
                disabled={!!systemBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importAssetArchive(file);
                }}
              />
              {systemBusy === 'assets' ? 'Импортируем…' : 'Выбрать ZIP и импортировать'}
            </label>
          </div>
          <div className="sa-emoji-asset-packs">
            {system?.assetPacks.map((pack) => (
              <div key={pack.id} className={'sa-emoji-asset-pack' + (pack.active ? ' is-active' : '')}>
                <button
                  type="button"
                  className="sa-emoji-asset-pack-activate"
                  disabled={!!systemBusy || !pack.item_count}
                  onClick={() => activateAssetPack(pack)}
                >
                  <span>{pack.name}</span>
                  <small>{EMOJI_ASSET_ROLE_LABEL[pack.role]} · {pack.item_count}</small>
                  <strong>{pack.active ? 'Используется' : 'Выбрать'}</strong>
                </button>
                <button
                  type="button"
                  className="sa-emoji-asset-pack-delete"
                  title="Удалить набор"
                  aria-label={`Удалить набор ${pack.name}`}
                  disabled={!!systemBusy}
                  onClick={() => deleteAssetPack(pack)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="sa-emoji-system-block">
          <h3>2. Структура и сортировка</h3>
          <p className="sa-hint">
            Поддерживается официальный emoji-test.txt и JSON с полями code, group,
            subgroup, name и keywords. Повторное применение перестраивает категории без перезагрузки картинок.
          </p>
          <div className="sa-emoji-import-row">
            <label className="sa-btn-ghost">
              <input
                type="file" accept=".txt,.json,text/plain,application/json" style={{ display: 'none' }}
                disabled={!!systemBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importStructure(file);
                }}
              />
              {systemBusy === 'structure' ? 'Применяем…' : 'Загрузить и применить структуру'}
            </label>
            <span className="sa-hint">
              Сейчас: {system?.structure.item_count || 0} записей, {system?.structure.group_count || 0} разделов
            </span>
          </div>
          <button type="button" className="sa-btn-quiet" disabled={!!systemBusy} onClick={migrateOldUnicodeTokens}>
            {systemBusy === 'migrate' ? 'Миграция…' : 'Заменить старые :u_...: в сообщениях'}
          </button>
        </div>
      </section>

      <h3 className="sa-emoji-categories-title">Категории каталога</h3>

      <div className="sa-emoji-pack-list" ref={packListRef}>
        {packOrder.map((pack) => {
        const open = openPack === pack.id;
        const items = pack.items || [];
        return (
          <div
            key={pack.id}
            data-emoji-pack-id={pack.id}
            className={`sa-emoji-pack${open ? ' is-open' : ''}${draggedPackId === pack.id ? ' is-dragging' : ''}`}
          >
            <div className="sa-emoji-pack-head">
              <button
                type="button"
                className="sa-pack-drag-handle"
                aria-label={`Переместить пак ${pack.name}`}
                title="Перетащить пак"
                {...packDragHandlers(pack)}
              >
                ⋮⋮
              </button>
              <button
                type="button"
                className="sa-emoji-pack-toggle"
                aria-expanded={open}
                onClick={() => setOpenPack(open ? null : pack.id)}
              >
                <span className="sa-emoji-pack-chevron">{open ? '▾' : '▸'}</span>
                <span className="sa-emoji-pack-title">{pack.name}</span>
                <span className="sa-hint">{items.length}</span>
              </button>
              <label className="switch" title={pack.enabled ? 'Показывается' : 'Скрыт'}>
                <input type="checkbox" checked={pack.enabled} onChange={(e) => update(pack.id, { enabled: e.target.checked })} />
                <span className="switch-track"><span className="switch-thumb" /></span>
              </label>
            </div>

            {open && (
              <div className="sa-emoji-pack-body">
                <div className="sa-emoji-pack-tools">
                  <input
                    className="sa-emoji-pack-name"
                    defaultValue={pack.name}
                    aria-label="Название пака"
                    onBlur={(e) => { if (e.target.value.trim() && e.target.value !== pack.name) update(pack.id, { name: e.target.value }); }}
                  />
                  <button type="button" className="sa-btn-danger" onClick={() => removePack(pack)}>Удалить пак</button>
                </div>

                <EmojiItemGrid
                  items={items}
                  onOpen={setEditing}
                  onReorder={(order) => saveOrder(pack.id, order)}
                />

                <div className="sa-emoji-pack-add">
                  <label className="sa-emoji-custom-add">
                    <input
                      type="file" accept="image/*" multiple style={{ display: 'none' }}
                      disabled={savingId === pack.id}
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        e.target.value = '';
                        if (files.length) uploadCustom(pack.id, files);
                      }}
                    />
                    {savingId === pack.id ? 'Загрузка…' : '+ Картинками'}
                  </label>
                  <div className="sa-emoji-unicode-add">
                    <input
                      value={newEmoji}
                      placeholder="😀"
                      maxLength={32}
                      aria-label="Системный смайлик"
                      onChange={(e) => setNewEmoji(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUnicode(pack.id); } }}
                    />
                    <button type="button" className="sa-btn-ghost" disabled={!newEmoji.trim()} onClick={() => addUnicode(pack.id)}>
                      + Символом
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      </div>

      <form onSubmit={create} className="sa-inline-form">
        <input type="text" placeholder="Новый пак…" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="btn-primary">Добавить</button>
      </form>

      {editing && (
        <EmojiItemModal
          item={editing}
          onClose={() => setEditing(null)}
          onApply={apply}
          onError={setError}
        />
      )}
    </div>
  );
}

/**
 * Сетка смайликов с перестановкой перетаскиванием. Кнопок «раньше/позже» больше
 * нет: в паке под сотню картинок, и доводить нужную до места кликами — работа
 * на весь день.
 *
 * Жест намеренно разный для мыши и пальца. Мышью — тянем сразу. Пальцем —
 * только после удержания: иначе первое же движение по сетке хватало бы смайлик
 * вместо прокрутки страницы, и до нижних рядов было бы не добраться. Прокрутка
 * глушится своим не-пассивным touchmove и только на время перетаскивания —
 * React вешает touchmove пассивно, и preventDefault из его обработчика не
 * работает вовсе (та же история, что с выделением сообщений в переписке).
 */
function EmojiItemGrid({
  items, onOpen, onReorder,
}: {
  items: EmojiItem[];
  onOpen: (item: EmojiItem) => void;
  onReorder: (order: number[]) => void;
}) {
  const { order, dragId, containerRef, tileHandlers } = useDragReorder({
    items, onReorder, dataAttribute: 'data-emoji-id', onTap: onOpen,
  });

  return (
    <div className="sa-emoji-grid" ref={containerRef}>
      {order.map((item) => (
        <button
          key={item.id}
          type="button"
          data-emoji-id={item.id}
          className={`sa-emoji-tile${dragId === item.id ? ' is-dragging' : ''}`}
          title={item.file_path ? `:${item.name}:` : item.emoji}
          {...tileHandlers(item)}
        >
          {item.file_path ? (
            <img src={resolveUploadUrl(item.file_path) || ''} alt={`:${item.name}:`} draggable={false} />
          ) : (
            <span className="sa-emoji-tile-char">{item.emoji}</span>
          )}
          {item.file_path && <span className="sa-emoji-tile-name">{item.name}</span>}
        </button>
      ))}
    </div>
  );
}

type Tab = 'users' | 'internet' | 'groups' | 'departments' | 'emoji' | 'stickers' | 'reactions' | 'selfchat' | 'google' | 'updates';

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Пользователи' },
  { id: 'internet', label: 'Интернет' },
  { id: 'groups', label: 'Группы' },
  { id: 'departments', label: 'Отделы' },
  { id: 'emoji', label: 'Смайлики' },
  { id: 'stickers', label: 'Стикеры' },
  { id: 'reactions', label: 'Реакции' },
  { id: 'selfchat', label: 'Избранное' },
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
        {tab === 'emoji' && <EmojiPacksPanel />}
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
