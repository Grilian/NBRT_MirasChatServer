import React, { useState, useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import Login from './pages/Login';
import Chat from './pages/Chat';
import SuperAdminApp from './pages/SuperAdminApp';
import TitleBar from './components/TitleBar';
import { isNativeMobile } from './utils/mobileNotify';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

function App() {
  const [user, setUser] = useState<any>(null);

  // Панель супер-админа — отдельный экран по хэшу в адресе (без роутера:
  // тот же index.html что и у обычного чата, серверу не нужно ничего знать
  // о дополнительных путях). #superadmin открывается прямо в браузере отдельно
  // от обычной сессии сотрудника/МИРАС-логина.
  const [isSuperAdminRoute, setIsSuperAdminRoute] = useState(
    typeof window !== 'undefined' && window.location.hash.startsWith('#superadmin')
  );

  useEffect(() => {
    const onHashChange = () => setIsSuperAdminRoute(window.location.hash.startsWith('#superadmin'));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

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

  if (isSuperAdminRoute) {
    return <SuperAdminApp />;
  }

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