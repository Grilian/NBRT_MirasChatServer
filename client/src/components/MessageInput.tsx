import React, { useLayoutEffect, useRef, useState } from 'react';

interface MessageInputProps {
  onSend: (text: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  /** Подпись-подсказка в поле ввода, когда отправка запрещена */
  placeholder?: string;
}

// Ограничение совпадает с серверным (MAX_MESSAGE_LENGTH в server/index.js):
// лучше не дать набрать лишнее, чем молча обрезать уже отправленное.
const MAX_LENGTH = 4000;
const MAX_FIELD_HEIGHT = 180;

const MessageInput: React.FC<MessageInputProps> = ({ onSend, onTyping, disabled, placeholder }) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
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

  // На телефоне не у всех клавиатур есть удобная кнопка "Вставить" рядом с
  // полем — а раскладка с ссылкой/кодом в буфере обмена как раз частый
  // случай для рабочего чата. Дописываем к тому, что уже набрано, а не
  // заменяем — так же ведёт себя вставка через системное меню.
  const handlePaste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip) return;
      setText((prev) => (prev + clip).slice(0, MAX_LENGTH));
      textareaRef.current?.focus();
      if (onTyping && clip.trim()) onTyping();
    } catch (e) {
      console.error('Не удалось прочитать буфер обмена:', e);
    }
  };

  const remaining = MAX_LENGTH - text.length;

  return (
    <form onSubmit={handleSubmit} className="composer">
      <div className="composer-field">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || (disabled ? 'Выберите чат…' : 'Написать сообщение…')}
          disabled={disabled}
        />
        {remaining < 200 && <span className="composer-counter">{remaining}</span>}
      </div>
      <button type="button" className="paste-btn" onClick={handlePaste} disabled={disabled} aria-label="Вставить из буфера обмена" title="Вставить">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" /></svg>
      </button>
      <button type="submit" className="send-btn" disabled={disabled || !text.trim()} aria-label="Отправить">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 22 12 3.4 3.4 3 10l13 2-13 2z" /></svg>
      </button>
    </form>
  );
};

export default MessageInput;
