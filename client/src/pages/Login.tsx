import React, { useState } from 'react';
import api from '../api/client';
import { isValidLogin, isValidPassword, isValidDisplayName, LOGIN_HINT, PASSWORD_HINT, DISPLAY_NAME_HINT } from '../utils/validation';

interface LoginProps {
  onLogin: (user: { id: number; username: string; token: string; source: string }) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isRegister) {
      if (!isValidLogin(username)) {
        setError(`Логин: ${LOGIN_HINT}`);
        return;
      }
      if (!isValidPassword(password)) {
        setError(`Пароль: ${PASSWORD_HINT}`);
        return;
      }
      if (!isValidDisplayName(displayName)) {
        setError('Имя: от 2 до 64 символов');
        return;
      }
    }

    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const body = isRegister ? { username, password, display_name: displayName } : { username, password };

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
        localStorage.setItem('displayName', data.display_name || data.username);
        localStorage.setItem('avatarPath', data.avatar_path || '');
        localStorage.setItem('bio', data.bio || '');
        localStorage.setItem('phone', data.phone || '');
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
            <label>Логин</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            {isRegister && <div className="field-hint">{LOGIN_HINT}</div>}
          </div>
          <div className="field">
            <label>Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {isRegister && <div className="field-hint">{PASSWORD_HINT}</div>}
          </div>
          {isRegister && (
            <div className="field">
              <label>Имя</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={DISPLAY_NAME_HINT}
                required
              />
            </div>
          )}

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
