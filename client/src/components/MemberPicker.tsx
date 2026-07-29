import React, { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';

interface PickerUser {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  group_id: number | null;
  group_name: string | null;
}

interface MemberPickerProps {
  /** Кто уже состоит в группе — не показываем, звать некуда. */
  excludeUserIds: number[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}

/**
 * Общий список выбора людей — используется и при создании группы, и при
 * добавлении в уже существующую. Справочник целиком (`/api/users`), а не
 * контакты: позвать в группу можно любого сотрудника.
 */
const MemberPicker: React.FC<MemberPickerProps> = ({ excludeUserIds, selectedIds, onChange }) => {
  const [users, setUsers] = useState<PickerUser[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/users').then(({ data }) => setUsers(data)).catch(console.error).finally(() => setLoading(false));
  }, []);

  const available = useMemo(
    () => users.filter((u) => !excludeUserIds.includes(u.id)),
    [users, excludeUserIds]
  );
  const filtered = available.filter((u) => nameFor(u).toLowerCase().includes(query.toLowerCase()));

  const toggle = (id: number) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  // «Всех» — в пределах текущего поиска, а не всего справочника: иначе кнопка
  // молча звала бы людей, которых сейчас не видно в списке.
  const allFilteredSelected = filtered.length > 0 && filtered.every((u) => selectedIds.includes(u.id));
  const selectAllFiltered = () => onChange(Array.from(new Set([...selectedIds, ...filtered.map((u) => u.id)])));
  const clearFiltered = () => {
    const filteredIds = new Set(filtered.map((u) => u.id));
    onChange(selectedIds.filter((id) => !filteredIds.has(id)));
  };

  return (
    <div className="member-picker">
      <div className="search directory-search">
        <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <input
          type="text"
          placeholder="Поиск по имени"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="member-picker-toolbar">
        <button
          type="button"
          className="cal-guests-toolbar-btn"
          onClick={allFilteredSelected ? clearFiltered : selectAllFiltered}
          disabled={filtered.length === 0}
        >
          {allFilteredSelected ? 'Снять всех' : 'Выбрать всех'}
        </button>
        {selectedIds.length > 0 && <span className="member-picker-count">Выбрано: {selectedIds.length}</span>}
      </div>
      <div className="directory-list">
        {loading && <div className="roster-empty">Загрузка...</div>}
        {!loading && filtered.length === 0 && <div className="roster-empty">Ничего не найдено</div>}
        {filtered.map((u) => (
          <label key={u.id} className="row directory-row member-picker-row">
            <input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggle(u.id)} />
            <Avatar name={nameFor(u)} avatarPath={u.avatar_path} />
            <div className="row-body">
              <div className="row-name"><span>{nameFor(u)}</span></div>
              <div className="row-preview">{u.group_name || 'Без группы'}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
};

export default MemberPicker;
