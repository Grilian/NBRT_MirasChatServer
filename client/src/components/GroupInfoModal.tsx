import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import MemberPicker from './MemberPicker';
import { acquireStandardKeyboardResizeMode } from '../utils/mobileKeyboard';
import { nameFor } from '../utils/user';
import {
  WritePolicy, WRITE_POLICY_ORDER, WRITE_POLICY_LABELS, WRITE_BLOCKED_HINT,
} from '../utils/writePolicy';

export interface GroupDetail {
  id: number;
  chat_id: string;
  name: string;
  created_by: number;
  created_at: number;
  member_count: number;
  members: { id: number; display_name: string | null; username: string; avatar_path: string | null; role: string }[];
  announcements_only: boolean;
  /** Фото профиля группы — ставит владелец. */
  avatar_path?: string | null;
  write_policy: WritePolicy;
  write_user_ids: number[];
  write_department_ids: number[];
}

interface GroupInfoModalProps {
  groupId: number;
  currentUserId: number;
  notificationsMuted?: boolean;
  onToggleNotifications?: (muted: boolean) => Promise<void>;
  onClose: () => void;
  /** Название/состав поменялись — обновить сводку в списке чатов. */
  onUpdated: (group: GroupDetail) => void;
  /** Группу удалили или человек вышел сам — увести с экрана переписки. */
  onGone: (chatId: string) => void;
}

const GroupInfoModal: React.FC<GroupInfoModalProps> = ({
  groupId, currentUserId, notificationsMuted = false, onToggleNotifications,
  onClose, onUpdated, onGone,
}) => {
  // Карточка группы открывается из шапки переписки, под ней остаётся
  // смонтированный MessageInput с Android adjustNothing — иначе переименование
  // группы и поиск в «Добавить участников» уходят под клавиатуру. См. тот же
  // приём в PollCreator.
  useEffect(() => acquireStandardKeyboardResizeMode(), []);

  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addIds, setAddIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationError, setNotificationError] = useState('');

  const load = () => {
    setLoading(true);
    api.get(`/groups/${groupId}`)
      .then(({ data }) => { setGroup(data); setNameDraft(data.name); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(load, [groupId]);

  const isOwner = group?.members.find((m) => m.id === currentUserId)?.role === 'owner';
  const avatarInputRef = React.useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = React.useState(false);

  const uploadAvatar = async (file: File) => {
    if (!group) return;
    setAvatarBusy(true);
    try {
      const form = new FormData();
      form.append('avatar', file);
      const { data } = await api.post(`/groups/${group.id}/avatar`, form);
      // Ответ содержит только путь: остальную карточку не трогаем, чтобы не
      // затереть то, что мог поменять кто-то другой, пока грузилось фото.
      setGroup((prev) => (prev ? { ...prev, avatar_path: data.avatar_path } : prev));
    } catch (e: any) {
      // Своего места под ошибку в шапке нет — показываем системным окном:
      // это редкий случай (неподходящий файл или потеря сети).
      window.alert(e?.response?.data?.error || 'Не удалось загрузить фото');
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!group || !trimmed || trimmed === group.name) { setEditingName(false); return; }
    try {
      const { data } = await api.put(`/groups/${group.id}`, { name: trimmed });
      setGroup(data);
      onUpdated(data);
    } catch (e) {
      console.error(e);
    } finally {
      setEditingName(false);
    }
  };

  const toggleAnnouncementsOnly = async () => {
    if (!group) return;
    try {
      const { data } = await api.put(`/groups/${group.id}`, { name: group.name, announcements_only: !group.announcements_only });
      setGroup(data);
      onUpdated(data);
    } catch (e) {
      console.error(e);
    }
  };

  // Списки отделов нужны только владельцу и только для режима «выбранные
  // отделы», но справочник маленький — тянем один раз вместе с карточкой,
  // чтобы переключение режима не подвешивало интерфейс запросом.
  const [departments, setDepartments] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    api.get('/departments')
      .then(({ data }) => setDepartments(data))
      .catch(() => { /* без справочника режим отделов просто покажет пустой список */ });
  }, []);

  /**
   * Сохранение политики. Списки передаются целиком, а не патчем: сервер
   * переписывает их полностью, и отправлять надо то состояние, которое должно
   * получиться, — иначе снятая галочка не удалялась бы.
   */
  const saveWritePolicy = async (
    policy: WritePolicy,
    lists?: { users?: number[]; departments?: number[] },
  ) => {
    if (!group) return;
    try {
      const { data } = await api.put(`/groups/${group.id}`, {
        name: group.name,
        write_policy: policy,
        write_user_ids: lists?.users ?? (policy === group.write_policy ? group.write_user_ids : []),
        write_department_ids: lists?.departments ?? (policy === group.write_policy ? group.write_department_ids : []),
      });
      setGroup(data);
      onUpdated(data);
    } catch (e) {
      console.error(e);
    }
  };

  const confirmAdd = async () => {
    if (!group || addIds.length === 0) { setAdding(false); return; }
    setBusy(true);
    try {
      const { data } = await api.post(`/groups/${group.id}/members`, { user_ids: addIds });
      setGroup(data);
      onUpdated(data);
      setAdding(false);
      setAddIds([]);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: number) => {
    if (!group) return;
    if (!window.confirm('Убрать этого человека из группы?')) return;
    try {
      const { data } = await api.delete(`/groups/${group.id}/members/${userId}`);
      setGroup(data);
      onUpdated(data);
    } catch (e) {
      console.error(e);
    }
  };

  const leaveGroup = async () => {
    if (!group) return;
    if (!window.confirm('Покинуть группу?')) return;
    try {
      await api.delete(`/groups/${group.id}/members/${currentUserId}`);
      onGone(group.chat_id);
    } catch (e) {
      console.error(e);
    }
  };

  const deleteGroup = async () => {
    if (!group) return;
    if (!window.confirm('Удалить группу без возможности восстановления? Переписка удалится у всех участников.')) return;
    try {
      await api.delete(`/groups/${group.id}`);
      onGone(group.chat_id);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleNotifications = async () => {
    if (!onToggleNotifications || notificationBusy) return;
    setNotificationBusy(true);
    setNotificationError('');
    try {
      await onToggleNotifications(!notificationsMuted);
    } catch (error: any) {
      setNotificationError(error.response?.data?.error || 'Не удалось изменить уведомления');
    } finally {
      setNotificationBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card directory-modal group-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">{adding ? 'Добавить участников' : 'Группа'}</div></div>
          <button type="button" className="icon-btn" onClick={adding ? () => setAdding(false) : onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {loading && <div className="roster-empty">Загрузка...</div>}

        {!loading && group && adding && (
          <>
            <MemberPicker
              excludeUserIds={group.members.map((m) => m.id)}
              selectedIds={addIds}
              onChange={setAddIds}
            />
            <div className="cal-dialog-actions create-group-actions">
              <button type="button" className="sa-btn-ghost" onClick={() => setAdding(false)}>Отмена</button>
              <button type="button" className="btn-primary" onClick={confirmAdd} disabled={busy || addIds.length === 0}>
                {busy ? 'Добавляем…' : `Добавить${addIds.length ? ` (${addIds.length})` : ''}`}
              </button>
            </div>
          </>
        )}

        {!loading && group && !adding && (
          <>
            <div className="group-info-header">
              {/* Фото профиля меняет только создатель: остальным это чужая
                  группа, и подменять её лицо они не должны. У постороннего
                  аватар остаётся картинкой, а не кнопкой. */}
              <div className={'group-info-avatar' + (isOwner ? ' is-editable' : '')}>
                <Avatar name={group.name} avatarPath={group.avatar_path || null} isGroup />
                {isOwner && (
                  <>
                    <button
                      type="button"
                      className="group-info-avatar-edit"
                      title="Сменить фото группы"
                      aria-label="Сменить фото группы"
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={avatarBusy}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                    </button>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadAvatar(file);
                      }}
                    />
                  </>
                )}
              </div>
              {isOwner && editingName ? (
                <input
                  className="group-info-name-input"
                  value={nameDraft}
                  autoFocus
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveName(); }
                    if (e.key === 'Escape') { setNameDraft(group.name); setEditingName(false); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="group-info-name"
                  onClick={() => isOwner && setEditingName(true)}
                  disabled={!isOwner}
                  title={isOwner ? 'Переименовать' : undefined}
                >
                  {group.name}
                </button>
              )}
              <div className="group-info-count">{group.member_count} {declineMembers(group.member_count)}</div>
              <button
                type="button"
                className={'group-info-notification-btn' + (notificationsMuted ? ' is-muted' : '')}
                onClick={toggleNotifications}
                disabled={notificationBusy}
                aria-pressed={notificationsMuted}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                  {notificationsMuted && <path d="M4 4l16 16" />}
                </svg>
                {notificationBusy ? 'Сохраняем…' : notificationsMuted ? 'Включить уведомления' : 'Отключить уведомления'}
              </button>
              {notificationError && <div className="group-info-notification-error" role="status">{notificationError}</div>}
            </div>

            {isOwner && (
              <button type="button" className="group-info-add-btn" onClick={() => setAdding(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                Добавить участников
              </button>
            )}

            {isOwner ? (
              <div className="group-info-write">
                <div className="settings-section-title">Кто может писать</div>
                <select
                  value={group.write_policy}
                  onChange={(e) => saveWritePolicy(e.target.value as WritePolicy)}
                >
                  {WRITE_POLICY_ORDER.map((p) => (
                    <option key={p} value={p}>{WRITE_POLICY_LABELS[p]}</option>
                  ))}
                </select>

                {/* Списки правятся сразу под выбором режима — отдельного окна
                    не заводим: без них режим не имеет смысла и человек всё
                    равно пойдёт их заполнять следующим действием. */}
                {group.write_policy === 'members' && (
                  <div className="group-info-write-list">
                    {group.members.map((m) => (
                      <label key={m.id} className="group-info-write-item">
                        <input
                          type="checkbox"
                          checked={group.write_user_ids.includes(m.id)}
                          onChange={(e) => saveWritePolicy('members', {
                            users: e.target.checked
                              ? [...group.write_user_ids, m.id]
                              : group.write_user_ids.filter((id) => id !== m.id),
                          })}
                        />
                        <span>{nameFor(m)}{m.id === currentUserId ? ' (вы)' : ''}</span>
                      </label>
                    ))}
                  </div>
                )}

                {group.write_policy === 'departments' && (
                  <div className="group-info-write-list">
                    {departments.length === 0 && <div className="group-info-write-empty">Отделы не заведены</div>}
                    {departments.map((d) => (
                      <label key={d.id} className="group-info-write-item">
                        <input
                          type="checkbox"
                          checked={group.write_department_ids.includes(d.id)}
                          onChange={(e) => saveWritePolicy('departments', {
                            departments: e.target.checked
                              ? [...group.write_department_ids, d.id]
                              : group.write_department_ids.filter((id) => id !== d.id),
                          })}
                        />
                        <span>{d.name}</span>
                      </label>
                    ))}
                  </div>
                )}

                {/* Счётчик просмотров к правам не относится — он про то, как
                    выглядят сообщения, и работает при любой политике. */}
                <div className="create-group-announce group-info-announce">
                  <span className="label">Показывать счётчик просмотров</span>
                  <label className="switch">
                    <input type="checkbox" checked={group.announcements_only} onChange={toggleAnnouncementsOnly} />
                    <span className="switch-track"><span className="switch-thumb" /></span>
                  </label>
                </div>
              </div>
            ) : group.write_policy !== 'all' && (
              <div className="group-info-announce-note">{WRITE_BLOCKED_HINT[group.write_policy]}</div>
            )}

            <div className="directory-list group-info-members">
              {group.members.map((m) => (
                <div key={m.id} className="row group-info-row">
                  <Avatar name={nameFor(m)} avatarPath={m.avatar_path} />
                  <div className="row-body">
                    <div className="row-name">
                      <span>{nameFor(m)}{m.id === currentUserId ? ' (вы)' : ''}</span>
                      {m.role === 'owner' && <span className="badge-admin">Создатель</span>}
                    </div>
                  </div>
                  {isOwner && m.role !== 'owner' && (
                    <button type="button" className="icon-btn-ghost danger" title="Убрать из группы" onClick={() => removeMember(m.id)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="group-info-footer">
              {isOwner ? (
                <button type="button" className="sa-btn-danger" onClick={deleteGroup}>Удалить группу</button>
              ) : (
                <button type="button" className="sa-btn-danger" onClick={leaveGroup}>Покинуть группу</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

function declineMembers(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'участник';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'участника';
  return 'участников';
}

export default GroupInfoModal;
