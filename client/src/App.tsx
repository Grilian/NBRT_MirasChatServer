import React, { useState, useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import Login from './pages/Login';
import Chat from './pages/Chat';
import TitleBar from './components/TitleBar';
import { isNativeMobile } from './utils/mobileNotify';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

function App() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const userId = localStorage.getItem('userId');
    const username = localStorage.getItem('username');

    if (token && userId && username) {
      setUser({ token, id: userId, username });
    }
  }, []);

  // Аппаратная кнопка "назад" на Android по умолчанию просто закрывает
  // приложение (нет истории браузера, по которой можно откатиться). Если
  // залогинены — навигацией внутри чата занимается сам Chat (свой листенер
  // там знает про view/mobileView); здесь обрабатываем только экран логина,
  // где "назад" должен просто сворачивать приложение, а не убивать процесс.
  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('backButton', () => {
      if (!user) {
        CapApp.minimizeApp();
      }
    });
    return () => { listenerPromise.then((h) => h.remove()); };
  }, [user]);

  const handleLogin = (userData: any) => {
    setUser(userData);
  };

  return (
    <div className={isElectron ? 'electron-frame' : undefined}>
      {isElectron && <TitleBar />}
      <div className="app-shell">
        {user ? <Chat /> : <Login onLogin={handleLogin} />}
      </div>
    </div>
  );
}

export default App;