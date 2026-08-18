import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';
import { resolveUploadUrl } from '../utils/uploads';
import ImageLightbox from './ImageLightbox';
import StatusPicker from './StatusPicker';
import ProfilePhotoEditor from './ProfilePhotoEditor';
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
  currentDepartment: string;
  currentPosition: string;
  currentBirthDate: string;
  /** Статус живёт здесь, а не в настройках: это то, что человек о себе сообщает. */
  statusPreset: string | null;
  statusCustom: string | null;
  onStatusChanged: (preset: string | null, custom: string | null) => void;
  onBack: () => void;
  onSaved: (profile: {
    username: string; display_name: string; avatar_path: string | null; bio: string; phone: string;
    department: string; position: string; birth_date: string;
  }) => void;
  onAvatarChanged: (avatarPath: string | null) => void;
}

const ProfileEdit: React.FC<ProfileEditProps> = ({
  currentUsername, currentDisplayName, currentAvatarPath, currentBio, currentPhone,
  currentDepartment, currentPosition, currentBirthDate,
  statusPreset, statusCustom, onStatusChanged,
  onBack, onSaved, onAvatarChanged
}) => {
  const [username, setUsername] = useState(currentUsername);
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [bio, setBio] = useState(currentBio);
  const [phone, setPhone] = useState(currentPhone);
  // Отдел назначает администратор в панели, здесь он только показывается:
  // отделами приглашают на события, и возможность записать себя в чужой отдел
  // означала бы выданный себе доступ к чужим встречам. Значение спрашиваем у
  // сервера, а не берём из пропса, чтобы после переназначения в панели тут не
  // висело устаревшее.
  const [departmentName, setDepartmentName] = useState(currentDepartment);
  const [position, setPosition] = useState(currentPosition);
  const [birthDate, setBirthDate] = useState(currentBirthDate);
  const [avatarPath, setAvatarPath] = useState(currentAvatarPath);
  useEffect(() => {
    let cancelled = false;
    api.get('/users/me')
      .then(({ data }) => { if (!cancelled) setDepartmentName(data.department || ''); })
      .catch(() => { /* останется то, что пришло сверху */ });
    return () => { cancelled = true; };
  }, []);

  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [photoEditorFile, setPhotoEditorFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Сам выбор статуса живёт в StatusPicker: его же открывают отдельным листом
  // по тапу на свой аватар, и держать две копии этой логики нельзя.

  // Просмотр аватара во весь экран — раньше по клику он только открывал выбор
  // файла, и посмотреть собственное фото целиком было нельзя вовсе.
  const [avatarPreview, setAvatarPreview] = useState(false);

  useEffect(() => {
    if (!avatarPreview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAvatarPreview(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [avatarPreview]);

  const handleAvatarPick = () => fileInputRef.current?.click();

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Сначала человек кадрирует фотографию в реальном макете профиля.
    // На сервер уходит уже подготовленный JPEG, а не исходник с телефона.
    setPhotoEditorFile(file);
  };

  const uploadPreparedAvatar = async (file: File) => {
    setPhotoEditorFile(null);
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

    const hasFormChanges = (
      username !== currentUsername
      || displayName !== currentDisplayName
      || bio !== currentBio
      || phone !== currentPhone
      || position !== currentPosition
      || birthDate !== currentBirthDate
      || !!newPassword
    );

    // «Сохранить» без изменений — это по сути «готово»: никаких запросов и
    // требования пароля, просто возвращаемся к просмотру своего профиля.
    if (!hasFormChanges) {
      onSaved({
        username: currentUsername, display_name: currentDisplayName, avatar_path: avatarPath,
        bio: currentBio, phone: currentPhone, department: departmentName || currentDepartment,
        position: currentPosition, birth_date: currentBirthDate,
      });
      return;
    }

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
        position,
        birth_date: birthDate,
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
        department: data.department || '',
        position: data.position || '',
        birth_date: data.birth_date || '',
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
        <div className="conv-title"><div className="settings-title">Профиль</div></div>
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="settings-body">
        <div className={'profile-avatar-section' + (avatarPath ? ' has-photo' : '')}>
          {avatarPath && (
            <button
              type="button"
              className="profile-edit-cover"
              onClick={() => setAvatarPreview(true)}
              disabled={avatarBusy}
              aria-label="Открыть фото"
            >
              <img src={resolveUploadUrl(avatarPath) || ''} alt="" />
            </button>
          )}
          <div className="profile-edit-cover-fade" />
          <div className="profile-avatar-content">
            {!avatarPath && (
              <button type="button" className="profile-avatar-btn" onClick={handleAvatarPick} disabled={avatarBusy} aria-label="Добавить фото">
                <Avatar name={nameFor({ username, display_name: displayName })} avatarPath={null} />
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleAvatarChange} style={{ display: 'none' }} />
            <div className="profile-avatar-name">{displayName || username}</div>
            <div className="profile-avatar-username">@{username}</div>
            <div className="profile-avatar-actions">
              <button type="button" onClick={handleAvatarPick} disabled={avatarBusy}>Сменить фото</button>
              {avatarPath && <button type="button" onClick={handleAvatarRemove} disabled={avatarBusy}>Убрать</button>}
            </div>
          </div>
        </div>

        <div className="settings-section-title">Статус</div>
        <StatusPicker
          statusPreset={statusPreset}
          statusCustom={statusCustom}
          onStatusChanged={onStatusChanged}
        />
        <div className="settings-hint">Срок применяется к статусу, который поставите следующим.</div>

        <form className="profile-form profile-form-card" onSubmit={handleSubmit} style={{ maxWidth: 360 }}>
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
            <label>Отдел</label>
            <div className="field-readonly">{departmentName || 'Не указан'}</div>
            <p className="field-hint">Назначается администратором.</p>
          </div>
          <div className="field">
            <label>Должность</label>
            <input type="text" value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Необязательно" maxLength={100} />
          </div>
          <div className="field">
            <label>Дата рождения</label>
            <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
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
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Только если что-то меняете" />
          </div>

          {error && <p className="form-error">{error}</p>}
          {success && <p className="form-success">{success}</p>}

          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </form>
      </div>

      {photoEditorFile && (
        <ProfilePhotoEditor
          file={photoEditorFile}
          displayName={displayName}
          username={username}
          onCancel={() => setPhotoEditorFile(null)}
          onApply={uploadPreparedAvatar}
        />
      )}

      {avatarPreview && avatarPath && (
        <ImageLightbox url={resolveUploadUrl(avatarPath) || ''} onClose={() => setAvatarPreview(false)} />
      )}
    </div>
  );
};

export default ProfileEdit;
