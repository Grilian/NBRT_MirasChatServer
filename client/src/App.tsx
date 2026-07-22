import React, { useState, useEffect } from 'react';
import Login from './pages/Login';
import Chat from './pages/Chat';
import TitleBar from './components/TitleBar';

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