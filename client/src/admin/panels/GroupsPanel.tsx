import React, { useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import { Group } from '../types';

export default function GroupsPanel({ groups, onChanged }: { groups: Group[]; onChanged: () => void }) {
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
