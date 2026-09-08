import React, { useEffect, useRef, useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import { ACCOUNT_TYPE_LABELS, AccountType, ROLE_LABELS } from '@/shared/lib/accountMeta';
import { AppVersions, Group, PASSWORD_STATUS_LABELS, UserRow } from '../types';

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

export default function UsersPanel({ users, groups, departments, onChanged, newUserIds, embedded }: {
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
