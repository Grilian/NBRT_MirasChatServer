import React, { useState } from 'react';
import superAdminApi from '@/shared/api/superAdminClient';
import { Group } from '../types';

export default function DepartmentsPanel({ departments, onChanged }: { departments: Group[]; onChanged: () => void }) {
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
