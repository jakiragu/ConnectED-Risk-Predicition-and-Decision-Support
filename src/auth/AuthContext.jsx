import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { setTokenProvider } from '../api/graphql.js';

/**
 * Session handling.
 *
 * Locally the token is minted by local/token.js and handed to the app through
 * the dev sign-in screen. On AWS this file is replaced by Amplify Auth's
 * fetchAuthSession, and everything below useAuth() stays as it is because the
 * actor shape is the same: sub, name, email, groups, schoolId.
 *
 * The claims decoded here are for display and routing only. The server reads
 * school and role from the signed token itself and never trusts these.
 */
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