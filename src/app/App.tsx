import { useState } from 'react';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { clearToken, getToken } from './lib/backendApi';

export default function App() {
  // If a token already exists in localStorage, skip the login screen
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getToken());

  const handleLogout = () => {
    clearToken();
    setIsAuthenticated(false);
  };

  return (
    <div className="size-full">
      {!isAuthenticated ? (
        <Login onLoginSuccess={() => setIsAuthenticated(true)} />
      ) : (
        <Dashboard onLogout={handleLogout} />
      )}
    </div>
  );
}
