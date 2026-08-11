import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';

interface GeneralChatUser {
  id: number;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
}

interface GeneralChatInfoModalProps {
  currentUserId: number;
  currentUserName: string;
  currentUserAvatarPath?: string | null;
  notificationsMuted: boolean;
  onToggleNotifications: (muted: boolean) => Promise<void>;
  onOpenUserInfo?: (userId: number) => void;
  onClose: () => void;
}

/**
 * Карточка общего чата. Своей строки в `chat_groups` у него нет — состав это
 * весь справочник (`/api/users`), поэтому список читается отдельно, а не через
 * `/groups/:id`. Управлять составом и правами отсюда нельзя: участие в общем
 * чате не выдаётся и не отбирается, оно есть у всех по определению. Смысл
 * окна — единственная настройка, которая у него всё-таки своя: уведомления.
 */
const GeneralChatInfoModal: React.FC<GeneralChatInfoModalProps> = ({
  currentUserId, currentUserName, currentUserAvatarPath, notificationsMuted,
  onToggleNotifications, onOpenUserInfo, onClose,
}) => {
  const [members, setMembers] = useState<GeneralChatUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationError, setNotificationError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<GeneralChatUser[]>('/users')
      .then(({ data }) => {
        if (cancelled) return;
        // Справочник намеренно не отдаёт самого спрашивающего (`u.id != ?`) —
        // он рассчитан на «кому написать». Здесь же это состав чата, и себя в
        // нём человек обязан видеть: иначе в общем чате всей организации
        // счётчик занижен на одного, и именно на него самого.
        const others = Array.isArray(data) ? data.filter((u) => u.id !== currentUserId) : [];
        setMembers([
          { id: currentUserId, username: currentUserName, display_name: currentUserName, avatar_path: currentUserAvatarPath ?? null },
          ...others,
        ]);
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUserId, currentUserName, currentUserAvatarPath]);

  const toggleNotifications = async () => {
    if (notificationBusy) return;
    setNotificationBusy(true);
    setNotificationError('');
    try {
      await onToggleNotifications(!notificationsMuted);
    } catch (error: any) {
      setNotificationError(error.response?.data?.error || 'Не удалось изменить уведомления');
    } finally {
      setNotificationBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card directory-modal group-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Общий чат</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="group-info-header">
          <Avatar name="Общий чат" isGeneral />
          {/* Кнопка, а не текст, и всегда disabled — ровно как имя чужой группы
              в GroupInfoModal: `.group-info-name` подсвечивается на наведении
              у всего, что не `:disabled`, а div отключённым не бывает. */}
          <button type="button" className="group-info-name" disabled>Общий чат</button>
          <div className="group-info-count">
            {loading ? 'Загружаем состав…' : `${members.length} ${declineMembers(members.length)}`}
          </div>
          <button
            type="button"
            className={'group-info-notification-btn' + (notificationsMuted ? ' is-muted' : '')}
            onClick={toggleNotifications}
            disabled={notificationBusy}
            aria-pressed={notificationsMuted}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              {notificationsMuted && <path d="M4 4l16 16" />}
            </svg>
            {notificationBusy ? 'Сохраняем…' : notificationsMuted ? 'Включить уведомления' : 'Отключить уведомления'}
          </button>
          {notificationError && <div className="group-info-notification-error" role="status">{notificationError}</div>}
        </div>

        <div className="group-info-announce-note">
          Здесь состоят все сотрудники — сообщение из этого чата видит вся организация.
        </div>

        <div className="directory-list group-info-members">
          {loading && <div className="roster-empty">Загрузка...</div>}
          {!loading && members.length === 0 && <div className="roster-empty">Сотрудники не найдены</div>}
          {members.map((member) => (
            <div key={member.id} className="row group-info-row">
              <button
                type="button"
                className="row-avatar-btn"
                onClick={() => onOpenUserInfo?.(member.id)}
                disabled={!onOpenUserInfo || member.id === currentUserId}
                aria-label="Профиль"
              >
                <Avatar name={nameFor(member)} avatarPath={member.avatar_path} />
              </button>
              <div className="row-body">
                <div className="row-name">
                  <span>{nameFor(member)}{member.id === currentUserId ? ' (вы)' : ''}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

function declineMembers(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сотрудник';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'сотрудника';
  return 'сотрудников';
}

export default GeneralChatInfoModal;
