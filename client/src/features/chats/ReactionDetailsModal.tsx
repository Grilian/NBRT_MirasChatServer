import type { MessageReaction } from '@/shared/api/types';
export type { MessageReaction };
import React, { useEffect } from 'react';
import Modal, { ModalHead } from '@/shared/ui/Modal';
import Avatar from '@/shared/ui/Avatar';
import { nameFor } from '@/shared/lib/user';
import { formatMoscowDateTime } from '@/shared/lib/time';
import { CustomEmojiMap, renderTextWithEmoji } from '@/features/emoji/customEmoji';


interface ReactionDetailsModalProps {
  reactions: MessageReaction[];
  /** Автор сообщения может снимать чужие реакции — только под своим. */
  canRemoveOthers: boolean;
  currentUserId: number;
  customEmoji?: CustomEmojiMap;
  onClose: () => void;
  onRemove: (userId: number) => void;
}

const ReactionDetailsModal: React.FC<ReactionDetailsModalProps> = ({
  reactions, canRemoveOthers, currentUserId, customEmoji = {}, onClose, onRemove,
}) => {
  return (
  <Modal onClose={onClose} className="directory-modal reactions-modal">
      <ModalHead title="Реакции" subtitle={reactions.length} onClose={onClose} />

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
              <span className="reaction-row-emoji">
                {renderTextWithEmoji(reaction.emoji, customEmoji, `rd${reaction.user.id}`)}
              </span>
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
  </Modal>
  );
};

export default ReactionDetailsModal;
