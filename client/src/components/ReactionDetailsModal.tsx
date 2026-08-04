import React from 'react';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';
import { formatMoscowDateTime } from '../utils/time';

export interface MessageReaction {
  emoji: string;
  created_at: number;
  user: {
    id: number;
    username: string;
    display_name: string | null;
    avatar_path: string | null;
  };
}

interface ReactionDetailsModalProps {
  reactions: MessageReaction[];
  /** Автор сообщения может снимать чужие реакции — только под своим. */
  canRemoveOthers: boolean;
  currentUserId: number;
  onClose: () => void;
  onRemove: (userId: number) => void;
}

const ReactionDetailsModal: React.FC<ReactionDetailsModalProps> = ({
  reactions, canRemoveOthers, currentUserId, onClose, onRemove,
}) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-card directory-modal reactions-modal" onClick={(e) => e.stopPropagation()}>
      <div className="conv-head">
        <div className="conv-title">
          <div className="settings-title">Реакции</div>
          <div className="status">{reactions.length}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="directory-list">
        {reactions.length === 0 && <div className="roster-empty">Реакций пока нет</div>}
        {reactions.map((reaction) => {
          const isMine = reaction.user.id === currentUserId;
          // Свою реакцию снимает сам человек, чужую — только автор сообщения.
          const removable = isMine || canRemoveOthers;

          return (
            <div key={reaction.user.id} className="row reaction-row">
              <Avatar name={nameFor(reaction.user)} avatarPath={reaction.user.avatar_path} />
              <div className="row-body">
                {/* Две строки, как в спеке: имя, под ним дата и время. */}
                <div className="row-name"><span>{nameFor(reaction.user)}{isMine ? ' (вы)' : ''}</span></div>
                <div className="row-preview">{formatMoscowDateTime(reaction.created_at)}</div>
              </div>
              <span className="reaction-row-emoji">{reaction.emoji}</span>
              {removable && (
                <button
                  type="button"
                  className="icon-btn-ghost danger reaction-row-remove"
                  title={isMine ? 'Убрать свою реакцию' : 'Убрать реакцию'}
                  onClick={() => onRemove(reaction.user.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  </div>
);

export default ReactionDetailsModal;
