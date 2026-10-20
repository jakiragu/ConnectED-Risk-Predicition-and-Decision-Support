import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * When this session's ID token expires, by this device's clock. The token's own
 * exp is stamped by Cognito's clock; if the two clocks disagree (a laptop that
 * slept, a Docker VM that drifted) a fresh token can look expired here, and the
 * app would renew it again and again. So the token's lifetime (exp - iat) is
 * counted from when this device received it.
 */
const expiresAt = (s) => {
  const c = decode(s?.idToken) || {};
  if (s?.obtainedAt && c.exp && c.iat) return s.obtainedAt + (c.exp - c.iat) * 1000;
  return (c.exp || 0) * 1000; // sessions saved before obtainedAt existed
};

/** Rejects if the promise has not settled in ms, so a stalled sign-in service cannot stall the app. */
const within = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error('Sign-in service did not answer'), { timeout: true })), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(t));
});
const RENEW_TIMEOUT_MS = 5000;
const RETRY_RENEW_AFTER_MS = 30_000; // after a failed renewal, requests go out at once with the token we have

export function AuthProvider({ children }) {
  const [session, setSession] = useState(load);
  // The session as of now, for the API client. Kept in a ref (not read from state in an effect) so a
  // request never goes out with an older token than the one just saved.
  const current = useRef(session);
  const renewing = useRef(null);
  const failedAt = useRef(0);

  const save = (next) => {
    const stamped = next && !next.obtainedAt ? { ...next, obtainedAt: Date.now() } : next;
    if (stamped) localStorage.setItem(KEY, JSON.stringify(stamped));
    else localStorage.removeItem(KEY);
    current.current = stamped;
    setSession(stamped);
  };

  /** One renewal at a time, never longer than RENEW_TIMEOUT_MS. */
  const renew = (s) => {
    renewing.current ??= within(refresh(s.refreshToken), RENEW_TIMEOUT_MS)
      .then((next) => { failedAt.current = 0; save(next); return next; })
      .catch((e) => { failedAt.current = Date.now(); throw e; })
      .finally(() => { renewing.current = null; });
    return renewing.current;
  };

  // Registered during the first render, before any page exists. Pages fetch in their own effects, and
  // React runs a child's effects before its parent's, so registering in an effect here was too late:
  // on a page load every first request went out with no token ("No authenticated identity on request").
  useState(() => setTokenProvider(async () => {
    const s = current.current;
    if (!s?.idToken) return null;
    const fresh = expiresAt(s) - Date.now() > 30_000;
    const coolingDown = Date.now() - failedAt.current < RETRY_RENEW_AFTER_MS;
    if (fresh || !s.refreshToken || !navigator.onLine || coolingDown) return s.idToken;
    // Expired (the tab was closed or the device slept): renew first. If renewal fails or stalls, send the
    // request with the token we have; the server's answer is shown, and the timer below signs out if needed.
    try {
      return (await renew(s)).idToken;
    } catch {
      return s.idToken;
    }
  }));

  // Renew a minute before expiry; if Cognito refuses (revoked or deactivated) sign out.
  useEffect(() => {
    if (!session?.refreshToken) return undefined;
    const wait = Math.max(expiresAt(session) - Date.now() - 60_000, 0);
    const t = setTimeout(() => {
      renew(session).catch((e) => {
        if (!navigator.onLine || e.timeout) return; // keep working; try again on the next request
        save(null);
      });
    }, wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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