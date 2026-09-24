import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, WaStatus } from '../../../shared/api';
import { api, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { eventHub, useServerEvents } from '../api/events';

interface Ctx {
  state: AppState | null;
  loading: boolean;
  wa: WaStatus | null;
  refresh: () => Promise<AppState | null>;
  /** Recovery key shown once after signup/recovery (memory only, never persisted). */
  pendingRecoveryKey: string | null;
  setPendingRecoveryKey: (k: string | null) => void;
}

const AppStateContext = createContext<Ctx | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
  const inflight = useRef<Promise<AppState | null> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const p = (async () => {
      try {
        const s = await api.state();
        setCsrfToken(s.csrfToken);
        setState(s);
        if (s.wa) setWa(s.wa);
        return s;
      } catch {
        return null;
      } finally {
        setLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void refresh());
    void refresh();
  }, [refresh]);

  // Live connection only while logged in.
  useEffect(() => {
    if (state?.authenticated) eventHub.start();
    else eventHub.stop();
  }, [state?.authenticated]);

  useServerEvents((ev) => {
    if (ev.type === 'wa_state') setWa(ev.status);
    else if (ev.type === 'sync_progress') setWa((w) => (w ? { ...w, sync: ev.sync } : w));
    else if (ev.type === 'session_revoked') void refresh();
  });

  const value = useMemo<Ctx>(
    () => ({ state, loading, wa, refresh, pendingRecoveryKey, setPendingRecoveryKey }),
    [state, loading, wa, refresh, pendingRecoveryKey],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): Ctx {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
