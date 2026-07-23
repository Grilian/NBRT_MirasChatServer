import React from 'react';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';

interface UserInfoModalProps {
  user: {
    id: number;
    username: string;
    display_name: string | null;
    avatarPath?: string | null;
    groupName?: string | null;
    bio?: string | null;
    phone?: string | null;
  };
  online?: boolean;
  onClose: () => void;
  onMessage: () => void;
}

const UserInfoModal: React.FC<UserInfoModalProps> = ({ user, online, onClose, onMessage }) => {
  const name = nameFor(user);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card user-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Профиль</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="user-info-body">
          <Avatar name={name} avatarPath={user.avatarPath} size="md" />
          <div className="user-info-name">{name}</div>
          <div className={'user-info-status' + (online ? ' is-online' : '')}>{online ? 'в сети' : 'не в сети'}</div>

          <div className="user-info-fields">
            {user.groupName && (
              <div className="user-info-field">
                <span className="user-info-label">Группа</span>
                <span>{user.groupName}</span>
              </div>
            )}
            {user.bio && (
              <div className="user-info-field">
                <span className="user-info-label">О себе</span>
                <span>{user.bio}</span>
              </div>
            )}
            {user.phone && (
              <div className="user-info-field">
                <span className="user-info-label">Телефон</span>
                <span>{user.phone}</span>
              </div>
            )}
          </div>

          <button type="button" className="btn-primary" onClick={onMessage}>Написать</button>
        </div>
      </div>
    </div>
  );
};

export default UserInfoModal;
