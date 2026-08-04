import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../api/client';
import EmojiPicker from './EmojiPicker';

export interface PendingImage {
  file_path: string;
  file_width: number;
  file_height: number;
}

export interface EditingMessage {
  id: number;
  text: string;
}

export interface ReplyingMessage {
  id: number;
  text: string;
  author: string;
  hasImage: boolean;
}

interface MessageInputProps {
  onSend: (text: string, image?: PendingImage) => void;
  onTyping?: () => void;
  disabled?: boolean;
  /** Подпись-подсказка в поле ввода, когда отправка запрещена */
  placeholder?: string;
  /** Правим сообщение — над полем ввода появляется панель, как в Telegram. */
  editing?: EditingMessage | null;
  onSubmitEdit?: (id: number, text: string) => void;
  onCancelEdit?: () => void;
  /** Стрелка вверх в пустом поле — правка последнего своего сообщения. */
  onRequestEditLast?: () => void;
  /** Отвечаем на сообщение — такая же панель над полем, как при правке. */
  replying?: ReplyingMessage | null;
  onCancelReply?: () => void;
}

// Ограничение совпадает с серверным (MAX_MESSAGE_LENGTH в server/index.js):
// лучше не дать набрать лишнее, чем молча обрезать уже отправленное.
const MAX_LENGTH = 4000;
const MAX_FIELD_HEIGHT = 180;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface StagedImage {
  previewUrl: string;
  uploading: boolean;
  uploaded: PendingImage | null;
  error: string | null;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSend, onTyping, disabled, placeholder,
  editing, onSubmitEdit, onCancelEdit, onRequestEditLast,
  replying, onCancelReply,
}) => {
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Поле ввода было однострочным <input>: длинное сообщение уезжало за
  // границу видимой области, а перенести строку было нельзя вовсе. Теперь
  // textarea, которая растёт под текст до разумного предела, а дальше
  // скроллится внутри себя.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_HEIGHT)}px`;
  }, [text]);

  // Локальный URL превью живёт, пока картинка не отправлена или не убрана —
  // без явного revoke он утёк бы памятью браузера при частой вставке фото.
  useEffect(() => () => { if (staged) URL.revokeObjectURL(staged.previewUrl); }, [staged]);

  // Вход в режим правки — подставляем текст и ставим курсор в конец.
  // Ключ по id, а не по самому объекту: иначе перерисовка родителя затирала бы
  // уже поправленный текст исходным.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editingId === null) return;
    setText(editing?.text || '');
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const end = (editing?.text || '').length;
      requestAnimationFrame(() => el.setSelectionRange(end, end));
    }
    // editing?.text намеренно не в зависимостях — см. комментарий выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const cancelEdit = () => {
    setText('');
    onCancelEdit?.();
  };

  // Вставка смайлика — в позицию курсора, а не в конец: иначе смайлик,
  // выбранный посреди набранной фразы, уезжал бы в её хвост.
  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    setText((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      const next = (prev.slice(0, start) + emoji + prev.slice(end)).slice(0, MAX_LENGTH);
      // Курсор ставим после вставленного, уже после того, как React
      // перерисует значение поля.
      requestAnimationFrame(() => {
        const caret = Math.min(start + emoji.length, next.length);
        el?.focus();
        el?.setSelectionRange(caret, caret);
      });
      return next;
    });
    onTyping?.();
  };

  const closeEmoji = useCallback(() => setEmojiOpen(false), []);

  const uploadImage = async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setStaged({ previewUrl, uploading: true, uploaded: null, error: null });

    const form = new FormData();
    form.append('image', file);
    try {
      const { data } = await api.post('/messages/upload-image', form);
      setStaged((prev) => (prev && prev.previewUrl === previewUrl
        ? { ...prev, uploading: false, uploaded: { file_path: data.file_path, file_width: data.file_width, file_height: data.file_height } }
        : prev));
    } catch (err: any) {
      setStaged((prev) => (prev && prev.previewUrl === previewUrl
        ? { ...prev, uploading: false, error: err.response?.data?.error || 'Не удалось загрузить изображение' }
        : prev));
    }
  };

  const stageFile = (file: File | null | undefined) => {
    if (!file || !IMAGE_MIME.includes(file.type) || disabled) return;
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    uploadImage(file);
  };

  const removeStaged = () => {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (disabled) return;

    // В режиме правки поле сохраняет сообщение, а не отправляет новое.
    if (editing) {
      if (trimmed) onSubmitEdit?.(editing.id, trimmed);
      setText('');
      onCancelEdit?.();
      return;
    }

    if (staged?.uploading) return; // ждём, пока картинка догрузится
    if (!trimmed && !staged?.uploaded) return;

    onSend(trimmed, staged?.uploaded || undefined);
    setText('');
    removeStaged();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter отправляет, Shift+Enter переносит строку — как в Telegram.
    // isComposing — набор через IME (иероглифы и т.п.): там Enter подтверждает
    // выбор символа, и отправлять по нему сообщение нельзя.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      cancelEdit();
      return;
    }

    if (e.key === 'Escape' && replying) {
      e.preventDefault();
      onCancelReply?.();
      return;
    }

    // Стрелка вверх в пустом поле — правка последнего своего сообщения, как в
    // Telegram. Только когда поле действительно пустое: иначе она должна
    // двигать курсор по набранному тексту.
    if (e.key === 'ArrowUp' && !editing && !text && onRequestEditLast) {
      e.preventDefault();
      onRequestEditLast();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value.slice(0, MAX_LENGTH));
    if (onTyping && e.target.value.trim()) {
      onTyping();
    }
  };

  // Вставка изображения из буфера (скриншот, скопированная картинка) — та же
  // механика, что в любом нормальном мессенджере: Ctrl+V прямо в поле ввода,
  // без отдельной кнопки. Текст из буфера вставляется как обычно, браузер
  // делает это сам — сюда попадает только случай с картинкой.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (IMAGE_MIME.includes(item.type)) {
        e.preventDefault();
        stageFile(item.getAsFile());
        return;
      }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    stageFile(file);
  };

  const remaining = MAX_LENGTH - text.length;

  return (
    <form
      onSubmit={handleSubmit}
      className={'composer' + (dragActive ? ' is-drag-over' : '')}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="composer-file-input"
        onChange={(e) => { stageFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={closeEmoji} />}

      <button
        type="button"
        className={'emoji-btn' + (emojiOpen ? ' is-active' : '')}
        // onMouseDown вместо onClick и с preventDefault: панель закрывается по
        // mousedown снаружи себя, и на обычном клике она успела бы закрыться
        // раньше, чем сюда дойдёт onClick, — кнопка не работала бы вовсе.
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!disabled) setEmojiOpen((v) => !v); }}
        disabled={disabled}
        aria-label="Смайлики"
        title="Смайлики"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
          <circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
          <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </button>

      <div className="composer-main">
        {editing && (
          <div className="composer-editing">
            <svg className="composer-editing-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            <div className="composer-editing-body">
              <div className="composer-editing-title">Редактирование</div>
              <div className="composer-editing-text">{editing.text}</div>
            </div>
            <button type="button" className="composer-editing-cancel" onClick={cancelEdit} aria-label="Отменить редактирование">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {/* Ответ и правка одновременно невозможны: правка занимает поле ввода
            текстом исходного сообщения, отвечать в этот момент нечем. */}
        {!editing && replying && (
          <div className="composer-editing composer-replying">
            <svg className="composer-editing-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
            <div className="composer-editing-body">
              <div className="composer-editing-title">Ответ · {replying.author}</div>
              <div className="composer-editing-text">
                {replying.text || (replying.hasImage ? '📷 Фото' : '')}
              </div>
            </div>
            <button type="button" className="composer-editing-cancel" onClick={() => onCancelReply?.()} aria-label="Отменить ответ">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {staged && (
          <div className="composer-attachment">
            <div className="composer-attachment-preview">
              <img src={staged.previewUrl} alt="" />
              {staged.uploading && <span className="composer-attachment-spinner" aria-hidden="true" />}
            </div>
            {staged.error && <span className="composer-attachment-error">{staged.error}</span>}
            <button type="button" className="composer-attachment-remove" onClick={removeStaged} aria-label="Убрать изображение">×</button>
          </div>
        )}

        <div className="composer-field">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder || (disabled ? 'Выберите чат…' : 'Написать сообщение…')}
            disabled={disabled}
          />
          {remaining < 200 && <span className="composer-counter">{remaining}</span>}
        </div>
      </div>

      {/* В режиме правки картинку не прикрепить: сервер меняет только текст. */}
      {!editing && (
        <button
          type="button"
          className="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Прикрепить изображение"
          title="Прикрепить изображение"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
        </button>
      )}
      <button
        type="submit"
        className="send-btn"
        disabled={disabled || (editing ? !text.trim() : (!text.trim() && !staged?.uploaded) || staged?.uploading)}
        aria-label={editing ? 'Сохранить' : 'Отправить'}
      >
        {editing ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 22 12 3.4 3.4 3 10l13 2-13 2z" /></svg>
        )}
      </button>
    </form>
  );
};

export default MessageInput;
