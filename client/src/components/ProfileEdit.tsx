import React, { useState } from 'react';
import api from '../api/client';

interface ProfileEditProps {
  currentUsername: string;
  onBack: () => void;
  onSaved: (newUsername: string) => void;
}

const ProfileEdit: React.FC<ProfileEditProps> = ({ currentUsername, onBack, onSaved }) => {
  const [username, setUsername] = useState(currentUsername);
  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!currentPassword) {
      setError('Введите текущий пароль для подтверждения');
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.put('/users/me', {
        username,
        password: newPassword || undefined,
        currentPassword,
      });
      setSuccess('Профиль обновлён');
      setNewPassword('');
      setCurrentPassword('');
      onSaved(data.username);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось сохранить изменения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-panel">
      <div className="conv-head">
        <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Назад" style={{ display: 'inline-flex' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="conv-title"><div className="settings-title">Редактировать профиль</div></div>
      </div>

      <div className="settings-body">
        <form className="profile-form" onSubmit={handleSubmit} style={{ maxWidth: 360 }}>
          <div className="field">
            <label>Имя пользователя</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label>Новый пароль</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Оставьте пустым, если не меняете" />
          </div>
          <div className="field">
            <label>Текущий пароль</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Для подтверждения изменений" required />
          </div>

          {error && <p className="form-error">{error}</p>}
          {success && <p className="form-success">{success}</p>}

          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ProfileEdit;
