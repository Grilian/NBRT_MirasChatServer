import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';

interface DirectoryUser {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  group_id: number | null;
  group_name: string | null;
}

interface DirectoryModalProps {
  existingContactIds: number[];
  onClose: () => void;
  onSelectUser: (user: DirectoryUser) => void;
}

const DirectoryModal: React.FC<DirectoryModalProps> = ({ existingContactIds, onClose, onSelectUser }) => {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/users')
      .then(({ data }) => setUsers(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = users.filter(u => nameFor(u).toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card directory-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Справочник сотрудников</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="search directory-search">
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input
            type="text"
            placeholder="Поиск по имени"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="directory-list">
          {loading && <div className="roster-empty">Загрузка...</div>}
          {!loading && filtered.length === 0 && <div className="roster-empty">Ничего не найдено</div>}
          {filtered.map(user => (
            <div key={user.id} className="row directory-row" role="button" tabIndex={0} onClick={() => onSelectUser(user)}>
              <Avatar name={nameFor(user)} avatarPath={user.avatar_path} />
              <div className="row-body">
                <div className="row-name"><span>{nameFor(user)}</span></div>
                <div className="row-preview">
                  {user.group_name || 'Без группы'}
                  {existingContactIds.includes(user.id) && ' · уже в списке чатов'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DirectoryModal;
