import React from 'react';
import { colorForName, initialsForName } from '../utils/avatar';
import { resolveUploadUrl } from '../utils/uploads';

interface AvatarProps {
  name: string;
  avatarPath?: string | null;
  size?: 'sm' | 'md';
  online?: boolean;
  isGeneral?: boolean;
  isGroup?: boolean;
  /** Личный чат «для себя» — закладка вместо инициалов. */
  isSelf?: boolean;
}

const Avatar: React.FC<AvatarProps> = ({ name, avatarPath, size, online, isGeneral, isGroup, isSelf }) => {
  if (isSelf) {
    return (
      <div className={'avatar avatar-self' + (size === 'sm' ? ' avatar-sm' : '')}>
        <svg width={size === 'sm' ? '15' : '18'} height={size === 'sm' ? '15' : '18'} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    );
  }

  if (isGeneral) {
    return (
      <div className="avatar avatar-general">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    );
  }

  if (isGroup) {
    // Загруженное фото группы показывается как обычный аватар; значок с
    // человечками остаётся только у групп без фото.
    if (avatarPath) {
      return (
        <img
          className={'avatar avatar-photo' + (size === 'sm' ? ' avatar-sm' : '')}
          src={resolveUploadUrl(avatarPath) || ''}
          alt=""
        />
      );
    }
    return (
      <div className={'avatar avatar-group' + (size === 'sm' ? ' avatar-sm' : '')}>
        <svg width={size === 'sm' ? '15' : '18'} height={size === 'sm' ? '15' : '18'} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
    );
  }

  const url = resolveUploadUrl(avatarPath);
  const className = 'avatar' + (size === 'sm' ? ' avatar-sm' : '');

  return (
    <div className={className} style={url ? undefined : { background: colorForName(name) }}>
      {url ? <img src={url} alt={name} className="avatar-img" /> : initialsForName(name)}
      {online !== undefined && <span className={'dot' + (online ? '' : ' offline')} />}
    </div>
  );
};

export default Avatar;
