import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import MemberPicker from './MemberPicker';
import { nameFor } from '../utils/user';

export interface GroupDetail {
  id: number;
  chat_id: string;
  name: string;
  created_by: number;
  created_at: number;
  member_count: number;
  members: { id: number; display_name: string | null; username: string; avatar_path: string | null; role: string }[];
}

interface GroupInfoModalProps {
  groupId: number;
  currentUserId: number;
  onClose: () => void;
  /** Название/состав поменялись — обновить сводку в списке чатов. */
  onUpdated: (group: GroupDetail) => void;
  /** Группу удалили или человек вышел сам — увести с экрана переписки. */
  onGone: (chatId: string) => void;
}

const GroupInfoModal: React.FC<GroupInfoModalProps> = ({ groupId, currentUserId, onClose, onUpdated, onGone }) => {
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addIds, setAddIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api.get(`/groups/${groupId}`)
      .then(({ data }) => { setGroup(data); setNameDraft(data.name); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(load, [groupId]);

  const isOwner = group?.members.find((m) => m.id === currentUserId)?.role === 'owner';

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
              <div className="avatar avatar-group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
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
            </div>

            {isOwner && (
              <button type="button" className="group-info-add-btn" onClick={() => setAdding(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                Добавить участников
              </button>
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
