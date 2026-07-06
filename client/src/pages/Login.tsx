import React, { useState } from 'react';
import api from '../api/client';

interface LoginProps {
  onLogin: (user: { id: number; username: string; token: string }) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const { data } = await api.post(endpoint, { username, password });

      if (isRegister) {
        setIsRegister(false);
        alert('Регистрация успешна! Теперь войдите.');
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.id);
        localStorage.setItem('username', data.username);
        onLogin(data);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка');
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>MirasChat</h1>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="text"
            placeholder="Имя пользователя"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={styles.input}
            required
          />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            required
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" style={styles.button}>
            {isRegister ? 'Зарегистрироваться' : 'Войти'}
          </button>
          <button
            type="button"
            onClick={() => setIsRegister(!isRegister)}
            style={styles.switchButton}
          >
            {isRegister ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}
          </button>
        </form>
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #1a472a 0%, #2d5a3d 100%)',
  },
  card: {
    background: '#ffffff',
    border: '2px solid #c9a227',
    borderRadius: '12px',
    padding: '40px',
    width: '100%',
    maxWidth: '420px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
  title: {
    textAlign: 'center',
    color: '#1a472a',
    marginBottom: '30px',
    fontSize: '32px',
    fontWeight: 'bold',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  input: {
    padding: '14px 18px',
    border: '1px solid #4a7c59',
    borderRadius: '8px',
    background: '#f5f5dc',
    color: '#2c3e2d',
    fontSize: '16px',
  },
  button: {
    padding: '14px',
    background: '#c9a227',
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: 'pointer',
    marginTop: '10px',
    transition: 'background 0.3s',
  },
  switchButton: {
    padding: '10px',
    background: 'transparent',
    color: '#2d5a3d',
    border: '1px solid #2d5a3d',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.3s',
  },
  error: {
    color: '#c0392b',
    textAlign: 'center',
    margin: '0',
  },
};

export default Login;