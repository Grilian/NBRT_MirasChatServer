import React, { useState } from 'react';
import api from '../api/client';
import MemberPicker from './MemberPicker';

export interface CreatedGroup {
  id: number;
  chat_id: string;
  name: string;
  created_by: number;
  created_at: number;
  member_count: number;
  members: { id: number; display_name: string | null; username: string; avatar_path: string | null; role: string }[];
}

interface CreateGroupModalProps {
  onClose: () => void;
  onCreated: (group: CreatedGroup) => void;
}

const CreateGroupModal: React.FC<CreateGroupModalProps> = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Введите название группы'); return; }

    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/groups', { name: trimmed, member_ids: memberIds });
      onCreated(data);
    } catch (e) {
      setError('Не удалось создать группу');
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card directory-modal create-group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Новая группа</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="create-group-name">
          <input
            type="text"
            placeholder="Название группы"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <MemberPicker excludeUserIds={[]} selectedIds={memberIds} onChange={setMemberIds} />

        {error && <div className="create-group-error">{error}</div>}

        <div className="cal-dialog-actions create-group-actions">
          <button type="button" className="sa-btn-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="btn-primary" onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? 'Создаём…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateGroupModal;
