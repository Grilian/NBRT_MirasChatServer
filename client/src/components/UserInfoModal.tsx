import React, { useEffect, useState } from 'react';
import api from '../api/client';
import Avatar from './Avatar';
import { nameFor } from '../utils/user';
import { formatDate } from '../utils/time';
import { AccountType, ACCOUNT_TYPE_LABELS, ROLE_LABELS } from '../utils/accountMeta';
import { resolveUploadUrl } from '../utils/uploads';
import { acquireStandardKeyboardResizeMode } from '../utils/mobileKeyboard';
import ChatAttachments from './ChatAttachments';

interface UserInfoModalProps {
  user: {
    id: number;
    username: string;
    display_name: string | null;
    avatarPath?: string | null;
    groupName?: string | null;
    bio?: string | null;
    phone?: string | null;
    department?: string | null;
    position?: string | null;
    birthDate?: string | null;
  };
  online?: boolean;
  notificationsMuted?: boolean;
  onToggleNotifications?: (muted: boolean) => Promise<void>;
  canModerate?: boolean;
  groups?: { id: number; name: string }[];
  /** Личная заметка о человеке — раньше правилась прямо в списке чатов
      отдельной кнопкой на строке; переехала сюда. */
  comment?: string;
  onUpdateComment?: (comment: string) => void;
  /**
   * Переписка с этим человеком — источник вложений для «Медиа», «Файлов»
   * и «Ссылок». Профиль открывается и там, где переписки ещё нет
   * (справочник «Люди»), поэтому необязателен: без него разделы вложений
   * просто не показываются, а не показывают пустоту.
   */
  chatId?: string | null;
  /** Нужен, чтобы отличить свои вложения от чужих: своё можно убрать. */
  currentUserId: number;
  /** Открыть переписку на конкретном сообщении — из списка вложений. */
  onOpenMessage?: (chatId: string, messageId: number) => void;
  onClose: () => void;
}

interface ModerationInfo {
  muted: boolean;
  account_type: AccountType;
  role: string | null;
  group_id: number | null;
  department_id: number | null;
}

const icon = (...paths: string[]) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);

// Уведомления уже подключены; остальные действия пока остаются заделом под UI.
const PLANNED_ACTIONS = [
  { key: 'call', label: 'Звонок', icon: icon('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.4 2.1L8.1 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.7 2Z') },
  { key: 'mute', label: 'Уведомления', icon: icon('M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0') },
  { key: 'search', label: 'Поиск по переписке', icon: icon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm21 21-4.3-4.3') },
  { key: 'more', label: 'Ещё', icon: icon('M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2') },
];

const UserInfoModal: React.FC<UserInfoModalProps> = ({
  user, online, notificationsMuted = false, onToggleNotifications,
  canModerate, groups = [], comment, onUpdateComment, chatId, currentUserId, onOpenMessage, onClose,
}) => {
  const name = nameFor(user);
  const coverUrl = resolveUploadUrl(user.avatarPath);

  // Профиль открывается и из шапки переписки, где под ним остаётся
  // смонтированный MessageInput с Android adjustNothing — тогда поле
  // комментария оказывается под клавиатурой. См. тот же приём в PollCreator.
  useEffect(() => acquireStandardKeyboardResizeMode(), []);

  // Подсказка о неготовом разделе гаснет сама через пару секунд.
  const [soonNote, setSoonNote] = useState<{ text: string; planned: boolean } | null>(null);
  useEffect(() => {
    if (!soonNote) return;
    const t = setTimeout(() => setSoonNote(null), 2200);
    return () => clearTimeout(t);
  }, [soonNote]);
  const [moderation, setModeration] = useState<ModerationInfo | null>(null);
  const [departments, setDepartments] = useState<{ id: number; name: string }[]>([]);
  const [modError, setModError] = useState('');
  const [notificationBusy, setNotificationBusy] = useState(false);

  const [editingComment, setEditingComment] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');

  // Открыли другой профиль поверх этого же модала (закрыть/открыть заново не
  // требуется — Chat.tsx просто меняет id) — незакрытая форма редактирования
  // иначе осталась бы висеть поверх уже чужой заметки.
  useEffect(() => {
    setEditingComment(false);
    setCommentDraft('');
  }, [user.id]);

  const startEditComment = () => {
    setCommentDraft(comment || '');
    setEditingComment(true);
  };

  const saveComment = () => {
    onUpdateComment?.(commentDraft.trim());
    setEditingComment(false);
  };

  const runProfileAction = async (key: string, label: string) => {
    if (key !== 'mute') {
      setSoonNote({ text: label, planned: true });
      return;
    }
    if (!onToggleNotifications) {
      setSoonNote({ text: 'Не удалось изменить уведомления', planned: false });
      return;
    }
    setNotificationBusy(true);
    try {
      await onToggleNotifications(!notificationsMuted);
      setSoonNote({
        text: notificationsMuted ? 'Уведомления включены' : 'Уведомления отключены',
        planned: false,
      });
    } catch (error: any) {
      setSoonNote({ text: error.response?.data?.error || 'Не удалось изменить уведомления', planned: false });
    } finally {
      setNotificationBusy(false);
    }
  };

  // Тишина/тип/группа/роль — не публичные поля, подгружаем отдельно и только
  // для тех, у кого есть право ими управлять (проверяется и на сервере).
  useEffect(() => {
    if (!canModerate) return;
    // Справочник отделов берём отсюда же: маршрут уже под ролью
    // «Администратор», и второй источник ради того же списка не нужен.
    api.get('/moderation/departments')
      .then(({ data }) => setDepartments(data))
      .catch(() => { /* без списка остальные поля продолжают работать */ });

    api.get(`/moderation/users/${user.id}`)
      .then(({ data }) => setModeration(data))
      .catch((err) => setModError(err.response?.data?.error || 'Не удалось загрузить'));
  }, [canModerate, user.id]);

  const updateModeration = async (patch: Partial<ModerationInfo>) => {
    try {
      const { data } = await api.put(`/moderation/users/${user.id}`, patch);
      setModeration(data);
      setModError('');
    } catch (err: any) {
      setModError(err.response?.data?.error || 'Не удалось сохранить');
    }
  };

  // modal-overlay-nested: профиль иногда открывают из уже открытого окна
  // (справочник «Люди», в будущем — из карточки группы). У всех модалок
  // одинаковый z-index — при равном z-index выигрывает более поздний в DOM,
  // а People рендерится после профиля и оказывалась поверх него.
  return (
    <div className="modal-overlay modal-overlay-nested" onClick={onClose}>
      <div className="modal-card user-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conv-head">
          <div className="conv-title"><div className="settings-title">Профиль</div></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="user-info-body">
          {/* Верх профиля целиком лежит НА фотографии: сверху она резкая, ниже
              уходит в размытие, и уже по размытому снимку идут имя, кнопки и
              плашка с данными. Цвет фона под ними берётся из самой фотографии —
              поэтому у каждого человека профиль своего оттенка. */}
          <div className={'user-info-top' + (coverUrl ? '' : ' has-no-photo')}>
            {coverUrl && <img className="user-info-cover-img" src={coverUrl} alt="" />}
            <div className="user-info-cover-fade" />

            <div className="user-info-top-content">
              {!coverUrl && (
                <div className="user-info-cover-fallback"><Avatar name={name} avatarPath={null} size="md" /></div>
              )}
              <div className="user-info-name">{name}</div>
              <div className={'user-info-status' + (online ? ' is-online' : '')}>{online ? 'в сети' : 'не в сети'}</div>

              {/* Уведомления работают; остальные кнопки пока показывают статус разработки. */}
              <div className="user-info-actions">
                {PLANNED_ACTIONS.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={'user-info-action' + (action.key === 'mute' && notificationsMuted ? ' is-muted' : '')}
                    title={action.key === 'mute'
                      ? (notificationsMuted ? 'Включить уведомления' : 'Отключить уведомления')
                      : action.label}
                    aria-label={action.key === 'mute'
                      ? (notificationsMuted ? 'Включить уведомления' : 'Отключить уведомления')
                      : action.label}
                    aria-pressed={action.key === 'mute' ? notificationsMuted : undefined}
                    disabled={action.key === 'mute' && notificationBusy}
                    onClick={() => runProfileAction(action.key, action.label)}
                  >
                    {action.icon}
                    {action.key === 'mute' && notificationsMuted && <span className="notification-muted-slash" aria-hidden="true" />}
                  </button>
                ))}
              </div>

              <div className="user-info-fields">
            {user.groupName && (
              <div className="user-info-field">
                <span className="user-info-label">Группа</span>
                <span>{user.groupName}</span>
              </div>
            )}
            {user.department && (
              <div className="user-info-field">
                <span className="user-info-label">Отдел</span>
                <span>{user.department}</span>
              </div>
            )}
            {user.position && (
              <div className="user-info-field">
                <span className="user-info-label">Должность</span>
                <span>{user.position}</span>
              </div>
            )}
            {user.birthDate && (
              <div className="user-info-field">
                <span className="user-info-label">Дата рождения</span>
                <span>{formatDate(user.birthDate)}</span>
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
            {onUpdateComment && (
              <div className="user-info-field">
                <span className="user-info-label">Комментарий</span>
                {editingComment ? (
                  <div className="user-info-comment-edit">
                    <input
                      type="text"
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveComment(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingComment(false); }
                      }}
                      placeholder="Заметка о человеке"
                      autoFocus
                    />
                    <button type="button" className="icon-btn-ghost" onClick={saveComment} aria-label="Сохранить">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M20 6 9 17l-5-5" /></svg>
                    </button>
                  </div>
                ) : (
                  <button type="button" className="user-info-comment-value" onClick={startEditComment}>
                    {comment ? <span>{comment}</span> : <span className="user-info-comment-placeholder">Добавить</span>}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                )}
              </div>
            )}
              </div>
            </div>
          </div>

          {canModerate && (
            <div className="user-info-admin">
              <div className="settings-section-title">Управление</div>
              {modError && <p className="form-error">{modError}</p>}
              {moderation ? (
                <div className="user-info-fields">
                  <div className="user-info-field">
                    <span className="user-info-label">Тишина</span>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={moderation.muted}
                        onChange={(e) => updateModeration({ muted: e.target.checked })}
                      />
                      <span className="switch-track"><span className="switch-thumb" /></span>
                    </label>
                  </div>
                  <div className="user-info-field">
                    <span className="user-info-label">Тип</span>
                    <select
                      value={moderation.account_type}
                      onChange={(e) => updateModeration({ account_type: e.target.value as AccountType })}
                    >
                      {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="user-info-field">
                    <span className="user-info-label">Группа</span>
                    <select
                      value={moderation.group_id ?? ''}
                      onChange={(e) => updateModeration({ group_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                  {/* Отдел правится и отсюда, но только админом: им приглашают
                      на события, и сам себе человек его выставить не может. */}
                  <div className="user-info-field">
                    <span className="user-info-label">Отдел</span>
                    <select
                      value={moderation.department_id ?? ''}
                      onChange={(e) => updateModeration({ department_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div className="user-info-field">
                    <span className="user-info-label">Роль</span>
                    <select
                      value={moderation.role ?? ''}
                      onChange={(e) => updateModeration({ role: e.target.value || null })}
                    >
                      <option value="">— не назначена —</option>
                      {Object.entries(ROLE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                !modError && <div className="user-info-admin-loading">Загрузка...</div>
              )}
            </div>
          )}

          {/* Вложения переписки. Без chatId (профиль открыт из справочника,
              где переписки ещё нет) раздел не показывается вовсе: пустые
              вкладки там означали бы «ничего не присылали», хотя присылать
              было некуда. */}
          {chatId && (
            <ChatAttachments
              chatId={chatId}
              currentUserId={currentUserId}
              onOpenMessage={onOpenMessage}
            />
          )}
        </div>

        {/* Ответ на нажатие того, что ещё не сделано. Само пропадает — просить
            закрыть подсказку, которая ничего не сообщила, незачем. */}
        {soonNote && (
          <div className="user-info-soon" role="status">
            {soonNote.text}{soonNote.planned ? ' — в разработке' : ''}
          </div>
        )}
      </div>
    </div>
  );
};

export default UserInfoModal;
