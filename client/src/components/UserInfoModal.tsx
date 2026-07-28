import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';
import { formatDate } from '../utils/time';
import { AccountType, ACCOUNT_TYPE_LABELS, ROLE_LABELS } from '../utils/accountMeta';

interface UserInfoModalProps {
  user: {
    id: number;
    username: string;
    display_name: string | null;
    avatarPath?: string | null;
    groupName?: string | null;
    bio?: string | null;
    phone?: string | null;
    department?: string | null;
    position?: string | null;
    birthDate?: string | null;
  };
  online?: boolean;
  canModerate?: boolean;
  groups?: { id: number; name: string }[];
  onClose: () => void;
  onMessage: () => void;
}

interface ModerationInfo {
  muted: boolean;
  account_type: AccountType;
  role: string | null;
  group_id: number | null;
  department_id: number | null;
}

const UserInfoModal: React.FC<UserInfoModalProps> = ({ user, online, canModerate, groups = [], onClose, onMessage }) => {
  const name = nameFor(user);
  const [moderation, setModeration] = useState<ModerationInfo | null>(null);
  const [departments, setDepartments] = useState<{ id: number; name: string }[]>([]);
  const [modError, setModError] = useState('');

  // Тишина/тип/группа/роль — не публичные поля, подгружаем отдельно и только
  // для тех, у кого есть право ими управлять (проверяется и на сервере).
  useEffect(() => {
    if (!canModerate) return;
    // Справочник отделов берём отсюда же: маршрут уже под ролью
    // «Администратор», и второй источник ради того же списка не нужен.
    api.get('/moderation/departments')
      .then(({ data }) => setDepartments(data))
      .catch(() => { /* без списка остальные поля продолжают работать */ });

    api.get(`/moderation/users/${user.id}`)
      .then(({ data }) => setModeration(data))
      .catch((err) => setModError(err.response?.data?.error || 'Не удалось загрузить'));
  }, [canModerate, user.id]);

  const updateModeration = async (patch: Partial<ModerationInfo>) => {
    try {
      const { data } = await api.put(`/moderation/users/${user.id}`, patch);
      setModeration(data);
      setModError('');
    } catch (err: any) {
      setModError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card user-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Профиль</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="user-info-body">
          <Avatar name={name} avatarPath={user.avatarPath} size="md" />
          <div className="user-info-name">{name}</div>
          <div className={'user-info-status' + (online ? ' is-online' : '')}>{online ? 'в сети' : 'не в сети'}</div>

          <div className="user-info-fields">
            {user.groupName && (
              <div className="user-info-field">
                <span className="user-info-label">Группа</span>
                <span>{user.groupName}</span>
              </div>
            )}
            {user.department && (
              <div className="user-info-field">
                <span className="user-info-label">Отдел</span>
                <span>{user.department}</span>
              </div>
            )}
            {user.position && (
              <div className="user-info-field">
                <span className="user-info-label">Должность</span>
                <span>{user.position}</span>
              </div>
            )}
            {user.birthDate && (
              <div className="user-info-field">
                <span className="user-info-label">Дата рождения</span>
                <span>{formatDate(user.birthDate)}</span>
              </div>
            )}
            {user.bio && (
              <div className="user-info-field">
                <span className="user-info-label">О себе</span>
                <span>{user.bio}</span>
              </div>
            )}
            {user.phone && (
              <div className="user-info-field">
                <span className="user-info-label">Телефон</span>
                <span>{user.phone}</span>
              </div>
            )}
          </div>

          <button type="button" className="btn-primary" onClick={onMessage}>Написать</button>

          {canModerate && (
            <div className="user-info-admin">
              <div className="settings-section-title">Управление</div>
              {modError && <p className="form-error">{modError}</p>}
              {moderation ? (
                <div className="user-info-fields">
                  <div className="user-info-field">
                    <span className="user-info-label">Тишина</span>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={moderation.muted}
                        onChange={(e) => updateModeration({ muted: e.target.checked })}
                      />
                      <span className="switch-track"><span className="switch-thumb" /></span>
                    </label>
                  </div>
                  <div className="user-info-field">
                    <span className="user-info-label">Тип</span>
                    <select
                      value={moderation.account_type}
                      onChange={(e) => updateModeration({ account_type: e.target.value as AccountType })}
                    >
                      {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="user-info-field">
                    <span className="user-info-label">Группа</span>
                    <select
                      value={moderation.group_id ?? ''}
                      onChange={(e) => updateModeration({ group_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                  {/* Отдел правится и отсюда, но только админом: им приглашают
                      на события, и сам себе человек его выставить не может. */}
                  <div className="user-info-field">
                    <span className="user-info-label">Отдел</span>
                    <select
                      value={moderation.department_id ?? ''}
                      onChange={(e) => updateModeration({ department_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div className="user-info-field">
                    <span className="user-info-label">Роль</span>
                    <select
                      value={moderation.role ?? ''}
                      onChange={(e) => updateModeration({ role: e.target.value || null })}
                    >
                      <option value="">— не назначена —</option>
                      {Object.entries(ROLE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                !modError && <div className="user-info-admin-loading">Загрузка...</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserInfoModal;
