import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { setTokenProvider } from '../api/graphql.js';
import { openFor } from '../offline/db.js';

const AuthContext = createContext(null);

const decode = (token) => {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
};

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('connected.token'));

  useEffect(() => {
    setTokenProvider(() => token);
  }, [token]);

  const value = useMemo(() => {
    const claims = token ? decode(token) : null;
    const expired = claims && claims.exp * 1000 < Date.now();
    const actor =
      claims && !expired
        ? {
            sub: claims.sub,
            name: claims.name || claims.email,
            email: claims.email,
            groups: claims['cognito:groups'] || [],
            schoolId: claims['custom:school_id'],
          }
        : null;

    if (actor) openFor(actor.sub);
    
    return {
      actor,
      token,
      signIn(nextToken) {
        localStorage.setItem('connected.token', nextToken);
        setToken(nextToken);
      },
      signOut() {
        localStorage.removeItem('connected.token');
        setToken(null);
      },
    };
  }, [token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);