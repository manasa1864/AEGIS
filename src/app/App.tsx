import { useState, useEffect, useCallback } from 'react';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { clearToken, getToken, SESSION_EXPIRED_EVENT } from './lib/backendApi';

export default function App() {
  // If a token already exists in localStorage, skip the login screen
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getToken());

  // Stable identity — Dashboard lists this in effect deps.
  const handleLogout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
  }, []);

  // Any API call that gets a 401 drops us back to the login screen.
  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, handleLogout);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleLogout);
  }, [handleLogout]);

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
