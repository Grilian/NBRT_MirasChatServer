import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../api/client';

export interface PendingImage {
  file_path: string;
  file_width: number;
  file_height: number;
}

interface MessageInputProps {
  onSend: (text: string, image?: PendingImage) => void;
  onTyping?: () => void;
  disabled?: boolean;
  /** Подпись-подсказка в поле ввода, когда отправка запрещена */
  placeholder?: string;
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

const MessageInput: React.FC<MessageInputProps> = ({ onSend, onTyping, disabled, placeholder }) => {
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const [dragActive, setDragActive] = useState(false);
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

      <div className="composer-main">
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
      <button type="submit" className="send-btn" disabled={disabled || (!text.trim() && !staged?.uploaded) || staged?.uploading} aria-label="Отправить">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 22 12 3.4 3.4 3 10l13 2-13 2z" /></svg>
      </button>
    </form>
  );
};

export default MessageInput;
