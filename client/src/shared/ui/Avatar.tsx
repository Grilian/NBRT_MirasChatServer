import React from 'react';
import { colorForName, initialsForName } from '@/shared/lib/avatar';
import { resolveUploadUrl } from '@/shared/lib/uploads';

interface AvatarProps {
  name: string;
  avatarPath?: string | null;
  size?: 'sm' | 'md';
  online?: boolean;
  isGeneral?: boolean;
  isGroup?: boolean;
  /** Личный чат «для себя» — закладка вместо инициалов. */
  isSelf?: boolean;
  /**
   * Сколько непрочитанных в этом чате.
   *
   * Счётчик живёт НА АВАТАРЕ, а не отдельной плашкой справа от строки. Это
   * решение концепции, и оно не косметическое: когда список сжимается до
   * иконок, от строки остаётся ровно аватар — плашка справа исчезала вместе
   * со строкой, и понять, где именно новые сообщения, было нельзя. Раньше
   * ради этого существовала вторая, отдельно позиционированная копия
   * счётчика для компактного режима.
   */
  unread?: number;
}

/**
 * Счётчик и точка присутствия разведены по РАЗНЫМ углам: иначе они
 * перекрывают друг друга, и одно из двух состояний пропадает. Обводка цветом
 * панели нужна, чтобы метка не сливалась ни со светлым, ни с тёмным, ни с
 * цветной подложкой аватара.
 */
const UnreadBadge: React.FC<{ count: number }> = ({ count }) => (
  <span className="avatar-unread" aria-label={`Непрочитанных: ${count}`}>
    {count > 99 ? '99+' : count}
  </span>
);

const Avatar: React.FC<AvatarProps> = ({
  name, avatarPath, size, online, isGeneral, isGroup, isSelf, unread,
}) => {
  const small = size === 'sm' ? ' avatar-sm' : '';
  const badge = unread && unread > 0 ? <UnreadBadge count={unread} /> : null;

  if (isSelf) {
    return (
      <div className={`avatar avatar-self${small}`}>
        <svg width={size === 'sm' ? '15' : '18'} height={size === 'sm' ? '15' : '18'} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        {badge}
      </div>
    );
  }

  if (isGeneral) {
    return (
      <div className="avatar avatar-general">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {badge}
      </div>
    );
  }

  if (isGroup) {
    // Загруженное фото группы показывается как обычный аватар; значок с
    // человечками остаётся только у групп без фото.
    if (avatarPath) {
      return (
        <div className={`avatar avatar-photo${small}`}>
          <img className="avatar-photo-img" src={resolveUploadUrl(avatarPath) || ''} alt="" />
          {badge}
        </div>
      );
    }
    return (
      <div className={`avatar avatar-group${small}`}>
        <svg width={size === 'sm' ? '15' : '18'} height={size === 'sm' ? '15' : '18'} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        {badge}
      </div>
    );
  }

  const url = resolveUploadUrl(avatarPath);

  return (
    <div className={`avatar${small}`} style={url ? undefined : { background: colorForName(name) }}>
      {url ? <img src={url} alt={name} className="avatar-img" /> : initialsForName(name)}
      {online !== undefined && <span className={'dot' + (online ? '' : ' offline')} />}
      {badge}
    </div>
  );
};

export default Avatar;
