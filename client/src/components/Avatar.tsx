import React from 'react';
import { colorForName, initialsForName } from '../utils/avatar';
import { resolveUploadUrl } from '../utils/uploads';

interface AvatarProps {
  name: string;
  avatarPath?: string | null;
  size?: 'sm' | 'md';
  online?: boolean;
  isGeneral?: boolean;
}

const Avatar: React.FC<AvatarProps> = ({ name, avatarPath, size, online, isGeneral }) => {
  if (isGeneral) {
    return (
      <div className="avatar avatar-general">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
