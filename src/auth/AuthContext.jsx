import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { setTokenProvider } from '../api/graphql.js';
import { openFor } from '../offline/db.js';
import { refresh } from './cognito.jsx';

const AuthContext = createContext(null);
const KEY = 'connected.session';

const decode = (token) => {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
};

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }) {
  const [session, setSession] = useState(load);

  const save = (next) => {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
    setSession(next);
  };

  useEffect(() => {
    setTokenProvider(() => session?.idToken || null);
  }, [session]);

  // Renew a minute before expiry; on failure (revoked or deactivated) sign out.
  useEffect(() => {
    if (!session?.refreshToken) return undefined;
    const exp = decode(session.idToken)?.exp * 1000 || 0;
    const wait = Math.max(exp - Date.now() - 60_000, 0);
    const t = setTimeout(() => {
      refresh(session.refreshToken).then(save).catch(() => {
        if (!navigator.onLine) return; // keep working offline; renew when back
        save(null);
      });
    }, wait);
    return () => clearTimeout(t);
  }, [session]);

  const value = useMemo(() => {
    const claims = session?.idToken ? decode(session.idToken) : null;
    const actor = claims
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
      isAdmin: Boolean(actor?.groups.includes('Admin')),
      signIn(tokens) {
        save(tokens);
      },
      signOut() {
        save(null);
      },
    };
  }, [session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);