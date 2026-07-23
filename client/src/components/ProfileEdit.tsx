import React, { useRef, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';
import {
  isValidLogin, isValidPassword, isValidDisplayName, isValidPhone,
  LOGIN_HINT, PASSWORD_HINT,
} from '../utils/validation';

interface ProfileEditProps {
  currentUsername: string;
  currentDisplayName: string;
  currentAvatarPath: string | null;
  currentBio: string;
  currentPhone: string;
  onBack: () => void;
  onSaved: (profile: { username: string; display_name: string; avatar_path: string | null; bio: string; phone: string }) => void;
  onAvatarChanged: (avatarPath: string | null) => void;
}

const ProfileEdit: React.FC<ProfileEditProps> = ({
  currentUsername, currentDisplayName, currentAvatarPath, currentBio, currentPhone, onBack, onSaved, onAvatarChanged
}) => {
  const [username, setUsername] = useState(currentUsername);
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [bio, setBio] = useState(currentBio);
  const [phone, setPhone] = useState(currentPhone);
  const [avatarPath, setAvatarPath] = useState(currentAvatarPath);
  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarPick = () => fileInputRef.current?.click();

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setAvatarBusy(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const { data } = await api.post('/users/me/avatar', formData);
      setAvatarPath(data.avatar_path);
      onAvatarChanged(data.avatar_path);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось загрузить фото');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarBusy(true);
    setError('');
    try {
      await api.delete('/users/me/avatar');
      setAvatarPath(null);
      onAvatarChanged(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Не удалось убрать фото');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!currentPassword) {
      setError('Введите текущий пароль для подтверждения');
      return;
    }
    if (!isValidLogin(username)) {
      setError(`Логин: ${LOGIN_HINT}`);
      return;
    }
    if (newPassword && !isValidPassword(newPassword)) {
      setError(`Пароль: ${PASSWORD_HINT}`);
      return;
    }
    if (!isValidDisplayName(displayName)) {
      setError('Имя: от 2 до 64 символов');
      return;
    }
    if (!isValidPhone(phone)) {
      setError('Некорректный номер телефона');
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.put('/users/me', {
        username,
        password: newPassword || undefined,
        currentPassword,
        display_name: displayName,
        bio,
        phone,
      });
      setSuccess('Профиль обновлён');
      setNewPassword('');
      setCurrentPassword('');
      onSaved({
        username: data.username,
        display_name: data.display_name,
        avatar_path: data.avatar_path,
        bio: data.bio || '',
        phone: data.phone || '',
      });
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
        <div className="profile-avatar-section">
          <button type="button" className="profile-avatar-btn" onClick={handleAvatarPick} disabled={avatarBusy} aria-label="Сменить фото">
            <Avatar name={nameFor({ username, display_name: displayName })} avatarPath={avatarPath} />
          </button>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleAvatarChange} style={{ display: 'none' }} />
          <div className="profile-avatar-actions">
            <button type="button" onClick={handleAvatarPick} disabled={avatarBusy}>Сменить фото</button>
            {avatarPath && <button type="button" onClick={handleAvatarRemove} disabled={avatarBusy}>Убрать</button>}
          </div>
        </div>

        <form className="profile-form" onSubmit={handleSubmit} style={{ maxWidth: 360 }}>
          <div className="field">
            <label>Имя</label>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="field">
            <label>О себе</label>
            <input type="text" value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Необязательно" maxLength={160} />
          </div>
          <div className="field">
            <label>Телефон</label>
            <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Необязательно" />
          </div>
          <div className="field">
            <label>Логин</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
            <div className="field-hint">{LOGIN_HINT}</div>
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
