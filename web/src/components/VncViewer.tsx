import RFB from '@novnc/novnc';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Icon } from './Icon';
import { Spinner } from './ui';

type Status = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Live view of the background Chromium (WhatsApp Web) via noVNC over the app's authenticated
 * WebSocket bridge (/api/vnc). View-only by default outside onboarding.
 */
export function VncViewer({ viewOnly, className }: { viewOnly: boolean; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    setStatus('connecting');
    (async () => {
      let password = '';
      try {
        password = (await api.vncCredentials()).password;
      } catch {
        if (!cancelled) setStatus('error');
        return;
      }
      if (cancelled || !hostRef.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const rfb = new RFB(hostRef.current, `${proto}://${window.location.host}/api/vnc`, { credentials: { password }, shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.qualityLevel = 7;
      rfb.compressionLevel = 2;
      rfb.background = 'transparent';
      rfb.viewOnly = viewOnly;
      rfb.addEventListener('connect', () => !cancelled && setStatus('connected'));
      rfb.addEventListener('disconnect', () => {
        if (cancelled) return;
        setStatus('disconnected');
        retry = window.setTimeout(() => setAttempt((a) => a + 1), 3000);
      });
      rfb.addEventListener('securityfailure', () => !cancelled && setStatus('error'));
      rfbRef.current = rfb;
    })();
    return () => {
      cancelled = true;
      if (retry) window.clearTimeout(retry);
      try {
        rfbRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      rfbRef.current = null;
    };
    // viewOnly is applied live below; reconnect only on attempt changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  return (
    <div className={`vnc-frame ${className ?? ''}`}>
      <div className="vnc-host" ref={hostRef} />
      {status !== 'connected' ? (
        <div className="vnc-overlay">
          {status === 'connecting' ? (
            <>
              <Spinner size={28} /> <span>Connecting to the browser…</span>
            </>
          ) : status === 'disconnected' ? (
            <>
              <Spinner size={28} /> <span>Connection lost, reconnecting…</span>
            </>
          ) : (
            <>
              <Icon name="warning" size={28} />
              <span>Could not connect to the browser.</span>
              <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
