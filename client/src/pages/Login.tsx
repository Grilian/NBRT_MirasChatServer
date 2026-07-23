import React, { useState } from 'react';
import api from '../api/client';

interface LoginProps {
  onLogin: (user: { id: number; username: string; token: string; source: string }) => void;
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
      const body = { username, password };

      const { data } = await api.post(endpoint, body);

      if (isRegister) {
        setIsRegister(false);
        alert('Регистрация успешна! Теперь войдите.');
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.id);
        localStorage.setItem('username', data.username);
        localStorage.setItem('source', data.source || 'local');
        localStorage.setItem('muted', String(!!data.muted));
        onLogin(data);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка');
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand-mark">
          <span className="roundel">M</span>
          <div className="word">
            MirasChat
            <span className="sub">Внутренняя переписка МИРАС</span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Имя пользователя</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="btn-primary">
            {isRegister ? 'Зарегистрироваться' : 'Войти'}
          </button>

          <div className="login-foot">
            <button type="button" onClick={() => setIsRegister(!isRegister)}>
              {isRegister ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
