import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../services/ApiClient.js';
import { flushReviewQueue } from '../services/reviewQueue.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // A stored token may be stale — confirm it with the server before trusting it.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!api.isAuthenticated()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.me();
        if (!cancelled) setUser(me);
      } catch {
        api.logout();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    restore();
    return () => { cancelled = true; };
  }, []);

  // A review that failed to reach the server during an earlier session is
  // queued locally (see reviewQueue.js) and gets one more chance here, at the
  // start of every visit, plus whenever the browser regains a connection —
  // so it is synced well before the user opens a new study session, not only
  // reactively the next time they happen to submit another review.
  useEffect(() => {
    if (!api.isAuthenticated()) return undefined;

    flushReviewQueue(api).catch(() => {});

    const onOnline = () => { flushReviewQueue(api).catch(() => {}); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user]);

  // Log the UI out when the client gives up on refreshing.
  useEffect(() => {
    api.onAuthChange = (tokens) => {
      if (!tokens) setUser(null);
    };
    return () => { api.onAuthChange = null; };
  }, []);

  const login = useCallback(async (email, password) => {
    setUser(await api.login(email, password));
  }, []);

  const register = useCallback(async (email, password, displayName) => {
    setUser(await api.register(email, password, displayName));
  }, []);

  const logout = useCallback(() => {
    // Clears local tokens synchronously and revokes them server-side in the
    // background; the UI must not wait on the network to sign out.
    api.logout();
    setUser(null);
  }, []);

  /** Signs out every device, then this one. */
  const logoutEverywhere = useCallback(async () => {
    try {
      await api.logoutEverywhere();
    } finally {
      // Even if the call failed, this device should not stay signed in — the
      // user has clearly decided the session is over.
      api.logout();
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout, logoutEverywhere }),
    [user, loading, login, register, logout, logoutEverywhere],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}
