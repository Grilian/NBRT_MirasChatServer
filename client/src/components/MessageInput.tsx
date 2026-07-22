import React, { useState } from 'react';

interface MessageInputProps {
  onSend: (text: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
}

const MessageInput: React.FC<MessageInputProps> = ({ onSend, onTyping, disabled }) => {
  const [text, setText] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim() && !disabled) {
      onSend(text.trim());
      setText('');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    if (onTyping && e.target.value.trim()) {
      onTyping();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="composer">
      <input
        type="text"
        value={text}
        onChange={handleChange}
        placeholder={disabled ? 'Выберите чат...' : 'Написать сообщение…'}
        disabled={disabled}
      />
      <button type="submit" className="send-btn" disabled={disabled || !text.trim()} aria-label="Отправить">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 22 12 3.4 3.4 3 10l13 2-13 2z" /></svg>
      </button>
    </form>
  );
};

export default MessageInput;
