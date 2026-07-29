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

  // Админ нажал "Сменить" — старый пароль недействителен, вход по логину
  // (без проверки пароля) вернул resetToken вместо обычной сессии. Пока он
  // не пуст, показываем только форму "задайте новый пароль", а не обычный вход.
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const finishLogin = (data: any) => {
    localStorage.setItem('token', data.token);
    localStorage.setItem('userId', data.id);
    localStorage.setItem('username', data.username);
    localStorage.setItem('source', data.source || 'local');
    localStorage.setItem('muted', String(!!data.muted));
    localStorage.setItem('displayName', data.display_name || data.username);
    localStorage.setItem('avatarPath', data.avatar_path || '');
    localStorage.setItem('bio', data.bio || '');
    localStorage.setItem('phone', data.phone || '');
    localStorage.setItem('department', data.department || '');
    localStorage.setItem('position', data.position || '');
    localStorage.setItem('birthDate', data.birth_date || '');
    localStorage.setItem('role', data.role || '');
    onLogin(data);
  };

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
      } else if (data.mustSetPassword) {
        setResetToken(data.resetToken);
        setPassword('');
      } else {
        finishLogin(data);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка');
    }
  };

  const handleCompleteReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isValidPassword(newPassword)) {
      setError(`Пароль: ${PASSWORD_HINT}`);
      return;
    }

    try {
      const { data } = await api.post('/auth/complete-reset', { resetToken, newPassword });
      finishLogin(data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка');
      // Если токен истёк/недействителен — возвращаем на обычный вход, а не
      // держим человека перед формой, которая больше не сработает.
      if (err.response?.status === 401) {
        setResetToken(null);
      }
    }
  };

  if (resetToken) {
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

          <form onSubmit={handleCompleteReset}>
            <p style={{ fontSize: 13.5, color: 'var(--ink-muted)', margin: '0 0 16px' }}>
              Администратор сбросил ваш пароль. Придумайте новый — у вас есть 15 минут с момента сброса.
            </p>
            <div className="field">
              <label>Новый пароль</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoFocus
              />
              <div className="field-hint">{PASSWORD_HINT}</div>
            </div>

            {error && <p className="login-error">{error}</p>}

            <button type="submit" className="btn-primary">Задать пароль и войти</button>
          </form>
        </div>
      </div>
    );
  }

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
              // При входе (не регистрации) поле не обязательно: если пароль
              // сбросил администратор, сервер определяет это по самому
              // аккаунту и не смотрит, что здесь введено — можно оставить
              // пустым. required тут раньше не пускал отправить форму вовсе,
              // и человек, забывший старый пароль, упирался в тупик: ввести
              // нечего, а форма не отправляется.
              required={isRegister}
            />
            {isRegister && <div className="field-hint">{PASSWORD_HINT}</div>}
            {!isRegister && (
              <div className="field-hint">
                Администратор сбросил пароль или вы его не помните? Оставьте поле пустым и нажмите «Войти».
              </div>
            )}
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
