import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import api from '../api/client';
import Avatar from './Avatar';
import ChatWindow from './ChatWindow';
import MessageInput, { EditingMessage, PendingImage, ReplyingMessage, SendResult } from './MessageInput';
import PollCreator from './PollCreator';
import PollCard from './PollCard';
import { MessageReaction } from './ReactionDetailsModal';
import { CustomEmojiMap, renderMessageText } from '../utils/customEmoji';
import { StickerCatalog } from '../utils/stickerCatalog';
import { resolveUploadUrl } from '../utils/uploads';
import { formatMoscowTime } from '../utils/time';
import { Poll, PollDraft } from '../types/poll';
import { ThreadSummary } from '../types/thread';

interface ThreadMessage {
  id: number;
  chat_id: string;
  thread_root_id?: number | null;
  text: string;
  file_path?: string | null;
  file_width?: number | null;
  file_height?: number | null;
  sticker_id?: number | null;
  sticker_fallback?: string | null;
  document_path?: string | null;
  document_name?: string | null;
  document_size?: number | null;
  document_mime?: string | null;
  sender_id: number;
  username: string;
  display_name?: string | null;
  avatar_path?: string | null;
  created_at: string;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  client_message_id?: string | null;
  edited_at?: string | null;
  deleted?: boolean | number;
  reply_to_id?: number | null;
  reply_to_text?: string | null;
  reply_to_file?: string | null;
  reply_to_sticker_fallback?: string | null;
  reply_to_document_name?: string | null;
  reply_to_author?: string | null;
  reply_to_deleted?: number | boolean | null;
  reactions?: MessageReaction[];
  poll?: Poll;
}

interface ThreadResponse {
  root: ThreadMessage;
  replies: ThreadMessage[];
  summary: ThreadSummary;
}

interface ThreadPanelProps {
  /** Разделитель для ручного изменения ширины — рисует владелец раскладки. */
  resizeHandle?: React.ReactNode;
  /** Каталог стикеров — прокидывается в ленту ветки, как и каталог смайликов. */
  stickerCatalog?: StickerCatalog;
  rootId: number;
  currentUserId: number;
  socket: Socket;
  customEmoji: CustomEmojiMap;
  reactionEmoji?: string[];
  autoFocus?: boolean;
  disabled?: boolean;
  /** Ответы считаются прочитанными только когда окно приложения действительно видно. */
  readActive?: boolean;
  onClose: () => void;
  onSummary: (rootId: number, summary: ThreadSummary) => void;
  onRead?: () => void;
  onRequestDelete: (message: { id: number; sender_id: number }) => void;
  onRemoveReaction?: (messageId: number, userId: number) => void;
}

function messageName(message: ThreadMessage): string {
  return message.display_name || message.username;
}

function replyCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} ответов`;
  if (mod10 === 1) return `${count} ответ`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ответа`;
  return `${count} ответов`;
}

function makeClientMessageId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  return `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

const ThreadPanel: React.FC<ThreadPanelProps> = ({
  resizeHandle,
  rootId, currentUserId, socket, customEmoji, stickerCatalog, reactionEmoji, autoFocus, disabled, readActive = true,
  onClose, onSummary, onRead,
  onRequestDelete, onRemoveReaction,
}) => {
  const [data, setData] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  const [replying, setReplying] = useState<ReplyingMessage | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollSubmitting, setPollSubmitting] = useState(false);
  const aliveRef = useRef(true);
  const readActiveRef = useRef(readActive);
  const lastMarkedReplyIdRef = useRef<number | null>(null);
  readActiveRef.current = readActive;

  const markRead = useCallback(async (): Promise<boolean> => {
    // Открытая вкладка Electron/браузера может оставаться смонтированной под
    // другим окном или при заблокированном телефоне. В таком состоянии ответ
    // ещё не был увиден и не должен исчезать из непрочитанных.
    if (!readActiveRef.current) return false;
    try {
      await api.post(`/messages/threads/${rootId}/read`);
      onRead?.();
      return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  }, [onRead, rootId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setData(null);
    setEditing(null);
    setReplying(null);
    try {
      const response = await api.get<ThreadResponse>(`/messages/threads/${rootId}`);
      if (!aliveRef.current) return;
      setData(response.data);
    } catch (requestError: any) {
      if (!aliveRef.current) return;
      setError(requestError.response?.status === 404 ? 'Ветка удалена или скрыта' : 'Не удалось открыть ветку');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [rootId]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => { aliveRef.current = false; };
  }, [load]);

  useEffect(() => {
    // Если ветка загрузилась в фоне, гасим её счётчик только после реального
    // возврата пользователя в видимое окно.
    if (!readActive || !data) return;
    const newestReplyId = data.replies.length
      ? data.replies[data.replies.length - 1].id
      : data.root.id;
    if (lastMarkedReplyIdRef.current === newestReplyId) return;
    void markRead().then((marked) => {
      if (marked) lastMarkedReplyIdRef.current = newestReplyId;
    });
  }, [data, markRead, readActive]);

  useEffect(() => {
    const incoming = (message: ThreadMessage) => {
      if (Number(message.thread_root_id) !== rootId) return;
      setData((previous) => {
        if (!previous || previous.replies.some((item) => item.id === message.id)) return previous;
        const replies = [...previous.replies, message];
        return { ...previous, replies };
      });
    };
    const edited = (message: { id: number; text: string; edited_at: string }) => {
      setData((previous) => previous ? {
        ...previous,
        root: previous.root.id === message.id ? { ...previous.root, ...message } : previous.root,
        replies: previous.replies.map((item) => item.id === message.id ? { ...item, ...message } : item),
      } : previous);
    };
    const statusChanged = (event: { id: number; status: ThreadMessage['status'] }) => {
      setData((previous) => previous ? {
        ...previous,
        replies: previous.replies.map((item) => item.id === event.id ? { ...item, status: event.status } : item),
      } : previous);
    };
    const statusesChanged = (event: { messageIds: number[]; status: ThreadMessage['status'] }) => {
      setData((previous) => previous ? {
        ...previous,
        replies: previous.replies.map((item) => event.messageIds.includes(item.id)
          ? { ...item, status: event.status }
          : item),
      } : previous);
    };
    const reactionsChanged = (event: { message_id: number; reactions: MessageReaction[] }) => {
      setData((previous) => previous ? {
        ...previous,
        root: previous.root.id === event.message_id ? { ...previous.root, reactions: event.reactions } : previous.root,
        replies: previous.replies.map((item) => item.id === event.message_id
          ? { ...item, reactions: event.reactions }
          : item),
      } : previous);
    };
    const removed = (event: { id: number; root_id: number }) => {
      if (Number(event.root_id) !== rootId) return;
      setData((previous) => previous ? {
        ...previous,
        replies: previous.replies.map((item) => item.id === event.id ? { ...item, deleted: true } : item),
      } : previous);
    };
    const pollUpdated = (event: { message_id: number; poll: Poll }) => {
      setData((previous) => previous ? {
        ...previous,
        root: previous.root.id === event.message_id ? { ...previous.root, poll: event.poll } : previous.root,
        replies: previous.replies.map((item) => item.id === event.message_id ? { ...item, poll: event.poll } : item),
      } : previous);
    };
    const rootRemoved = (event: { id: number }) => { if (event.id === rootId) onClose(); };
    const rootsRemoved = (event: { ids: number[] }) => { if (event.ids.includes(rootId)) onClose(); };
    const threadHidden = (event: { root_id: number }) => { if (event.root_id === rootId) onClose(); };
    const messageHidden = (event: { id: number }) => {
      setData((previous) => previous ? {
        ...previous,
        replies: previous.replies.filter((item) => item.id !== event.id),
      } : previous);
    };

    socket.on('thread_message', incoming);
    socket.on('message_edited', edited);
    socket.on('message_status', statusChanged);
    socket.on('message_status_bulk', statusesChanged);
    socket.on('reactions_changed', reactionsChanged);
    socket.on('thread_message_deleted', removed);
    socket.on('poll_updated', pollUpdated);
    socket.on('message_deleted', rootRemoved);
    socket.on('messages_deleted', rootsRemoved);
    socket.on('thread_hidden', threadHidden);
    socket.on('message_hidden', messageHidden);
    return () => {
      socket.off('thread_message', incoming);
      socket.off('message_edited', edited);
      socket.off('message_status', statusChanged);
      socket.off('message_status_bulk', statusesChanged);
      socket.off('reactions_changed', reactionsChanged);
      socket.off('thread_message_deleted', removed);
      socket.off('poll_updated', pollUpdated);
      socket.off('message_deleted', rootRemoved);
      socket.off('messages_deleted', rootsRemoved);
      socket.off('thread_hidden', threadHidden);
      socket.off('message_hidden', messageHidden);
    };
  }, [onClose, rootId, socket]);

  useEffect(() => {
    // Фоновая панель не должна локально затирать серверный unread_count. Для
    // неё сводку обновляет общий socket-обработчик; здесь пересчитываем её
    // только когда пользователь действительно видит ветку.
    if (!data || !readActive) return;
    const visible = data.replies.filter((item) => !item.deleted);
    const authors = [] as ThreadSummary['recent_authors'];
    const seen = new Set<number>();
    for (let index = visible.length - 1; index >= 0 && authors.length < 2; index -= 1) {
      const message = visible[index];
      if (seen.has(message.sender_id)) continue;
      seen.add(message.sender_id);
      authors.push({
        id: message.sender_id,
        username: message.username,
        display_name: message.display_name,
        avatar_path: message.avatar_path,
      });
    }
    onSummary(rootId, {
      reply_count: visible.length,
      unread_count: 0,
      last_reply_at: visible.length ? visible[visible.length - 1].created_at : null,
      recent_authors: authors,
    });
  }, [data, onSummary, readActive, rootId]);

  const emitThreadMessage = useCallback((payload: Record<string, unknown>) => new Promise<SendResult>((resolve) => {
    socket.timeout(15_000).emit('thread_message', { rootId, clientMessageId: makeClientMessageId(), ...payload },
      (timeoutError: Error | null, ack: { ok?: boolean; error?: string }) => {
        if (timeoutError) resolve({ ok: false, error: 'Сервер не ответил' });
        else resolve(ack?.ok ? { ok: true } : { ok: false, error: ack?.error || 'Не удалось отправить' });
      });
  }), [rootId, socket]);

  // Стикер в ветке отправляется тем же событием, что и текст, — своей очереди
  // у ветки нет (её сообщения не проходят через outgoingQueue), поэтому просто
  // отдельный вызов вместо прикрепления к полю ввода.
  const sendSticker = useCallback(async (stickerId: number) => {
    const result = await emitThreadMessage({ stickerId, replyToId: replying?.id });
    if (result.ok) setReplying(null);
  }, [emitThreadMessage, replying]);

  const send = useCallback(async (text: string, image?: PendingImage): Promise<SendResult> => {
    const replyToId = replying?.id;
    if (!image) {
      const result = await emitThreadMessage({ text, replyToId });
      if (result.ok) setReplying(null);
      return result;
    }
    try {
      const form = new FormData();
      form.append('image', image.file);
      const uploaded = await api.post('/messages/upload-image', form);
      const result = await emitThreadMessage({
        text,
        filePath: uploaded.data.file_path,
        fileWidth: uploaded.data.file_width,
        fileHeight: uploaded.data.file_height,
        replyToId,
      });
      if (result.ok) setReplying(null);
      return result;
    } catch (uploadError: any) {
      return { ok: false, error: uploadError.response?.data?.error || 'Не удалось загрузить изображение' };
    }
  }, [emitThreadMessage, replying?.id]);

  const createPoll = async (draft: PollDraft) => {
    setPollSubmitting(true);
    const result = await emitThreadMessage({ poll: draft, replyToId: replying?.id });
    setPollSubmitting(false);
    if (result.ok) {
      setPollOpen(false);
      setReplying(null);
    }
  };

  const visibleReplies = data?.replies.filter((message) => !message.deleted) || [];
  const root = data?.root;

  return (
    <aside className="thread-panel" aria-label="Ветка">
      {resizeHandle}
      <header className="thread-header">
        <div>
          <strong>Ветка</strong>
          {data && <span>{replyCountLabel(visibleReplies.length)}</span>}
        </div>
        <button type="button" className="thread-close" onClick={onClose} aria-label="Закрыть ветку">
          <span className="thread-close-desktop">×</span>
          <span className="thread-close-mobile">‹</span>
        </button>
      </header>

      {loading && <div className="thread-state">Загрузка ветки…</div>}
      {error && <div className="thread-state is-error">{error}</div>}
      {root && (
        <>
          <div className="thread-root">
            <Avatar name={messageName(root)} avatarPath={root.avatar_path} size="sm" />
            <div className="thread-root-body">
              <div className="thread-author"><strong>{messageName(root)}</strong><span>{formatMoscowTime(root.created_at)}</span></div>
              {!!root.file_path && <img className="thread-image" src={resolveUploadUrl(root.file_path) || ''} alt="" />}
              {root.poll ? (
                <PollCard
                  poll={root.poll}
                  onVote={(pollId, optionIds) => socket.emit('poll_vote', { pollId, optionIds })}
                  onAddOption={(pollId, text) => socket.emit('poll_add_option', { pollId, text })}
                />
              ) : (
                <div className="thread-text">{renderMessageText(root.text, customEmoji, `tr${root.id}`)}</div>
              )}
            </div>
          </div>
          <div className="thread-divider"><span>{visibleReplies.length ? replyCountLabel(visibleReplies.length) : 'Ответов пока нет'}</span></div>
          <div className="thread-messages">
            <ChatWindow
              chatId={root.chat_id}
              messages={visibleReplies}
              currentUserId={currentUserId}
              showAuthors
              onStartEdit={(id, text) => setEditing({ id, text })}
              editingId={editing?.id ?? null}
              onDeleteMessage={(id) => {
                const message = visibleReplies.find((item) => item.id === id);
                if (message) onRequestDelete({ id, sender_id: message.sender_id });
              }}
              onStartReply={setReplying}
              reactionEmoji={reactionEmoji}
              customEmoji={customEmoji}
              stickerCatalog={stickerCatalog}
              onToggleReaction={(messageId, emoji) => socket.emit('reaction_set', { messageId, emoji })}
              onRemoveReaction={onRemoveReaction}
              onVotePoll={(pollId, optionIds) => socket.emit('poll_vote', { pollId, optionIds })}
              onAddPollOption={(pollId, text) => socket.emit('poll_add_option', { pollId, text })}
              onStopPoll={(pollId) => socket.emit('poll_stop', { pollId })}
            />
          </div>
          <MessageInput
            onSend={send}
            disabled={disabled}
            placeholder="Ответить в ветке"
            customEmoji={customEmoji}
            autoFocus={autoFocus}
            editing={editing}
            onSubmitEdit={(id, text) => { socket.emit('message_edit', { id, text }); setEditing(null); }}
            onCancelEdit={() => setEditing(null)}
            replying={replying}
            onCancelReply={() => setReplying(null)}
            onCreatePoll={() => setPollOpen(true)}
            onSendSticker={sendSticker}
          />
        </>
      )}
      {pollOpen && <PollCreator submitting={pollSubmitting} onClose={() => setPollOpen(false)} onCreate={createPoll} />}
    </aside>
  );
};

export default ThreadPanel;
