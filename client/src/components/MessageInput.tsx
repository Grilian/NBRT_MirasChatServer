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
    <form onSubmit={handleSubmit} style={styles.container}>
      <input
        type="text"
        value={text}
        onChange={handleChange}
        placeholder={disabled ? 'Выберите чат...' : 'Введите сообщение...'}
        disabled={disabled}
        style={styles.input}
      />
      <button type="submit" disabled={disabled || !text.trim()} style={styles.button}>
        ➤
      </button>
    </form>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    display: 'flex',
    gap: '12px',
    padding: '16px 24px',
    background: '#ffffff',
    borderTop: '2px solid #c9a227',
  },
  input: {
    flex: 1,
    padding: '14px 18px',
    border: '1px solid #4a7c59',
    borderRadius: '24px',
    background: '#f5f5dc',
    color: '#2c3e2d',
    fontSize: '15px',
    outline: 'none',
  },
  button: {
    padding: '14px 20px',
    background: '#c9a227',
    color: '#ffffff',
    border: 'none',
    borderRadius: '50%',
    fontSize: '18px',
    cursor: 'pointer',
    width: '48px',
    height: '48px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

export default MessageInput;