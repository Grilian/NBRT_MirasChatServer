import React, { useState, useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import Login from './pages/Login';
import Chat from './pages/Chat';
import SuperAdminApp from './pages/SuperAdminApp';
import TitleBar from './components/TitleBar';
import { isNativeMobile } from './utils/mobileNotify';
import { reportAppVersion } from './utils/reportVersion';

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

  // Сообщаем серверу версию приложения, как только появилась сессия — и при
  // восстановлении из localStorage, и после явного входа. Нужно панели
  // управления, чтобы видеть, до кого обновление доехало.
  useEffect(() => {
    if (user) reportAppVersion();
  }, [user]);

  // Аппаратная кнопка "назад" на Android по умолчанию просто закрывает
  // приложение (нет истории браузера, по которой можно откатиться). Если
  // залогинены — навигацией внутри чата занимается сам Chat (свой листенер
  // там знает про раздел и открытую переписку); здесь обрабатываем только логин,
  // где "назад" должен просто сворачивать приложение, а не убивать процесс.
  // Подписываемся один раз, состояние читаем из ref: пересоздание нативной
  // подписки на каждую смену user умеет оставлять осиротевший листенер со
  // старым замороженным состоянием (подробности — в таком же обработчике
  // в Chat.tsx).
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    if (!isNativeMobile) return;
    const listenerPromise = CapApp.addListener('backButton', () => {
      if (!userRef.current) {
        CapApp.minimizeApp();
      }
    });
    return () => { listenerPromise.then((h) => h.remove()); };
  }, []);

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