import dns from 'node:dns/promises';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { VncCredentials } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { requireSession } from '../http/server.js';

const MAX_SESSIONS = 3;
const REVALIDATE_MS = 30_000;
const HIGH_WATER = 8 * 1024 * 1024;

/**
 * Authenticated WebSocket ↔ TCP bridge to x11vnc inside the chromium container. The VNC port is only
 * reachable on the internal backend network; this bridge is the only way in, and it requires a valid
 * session plus a same-origin Origin header (enforced by the global onRequest hook).
 */
export function registerVncRoutes(app: FastifyInstance, ctx: AppContext): void {
  let open = 0;
  const lastAudit = new Map<string, number>();

  app.get('/api/vnc/credentials', async () => {
    const res: VncCredentials = { password: ctx.config.vncPassword };
    return res;
  });

  app.get('/api/vnc', { websocket: true, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (socket, req) => {
    const session = requireSession(req);
    if (open >= MAX_SESSIONS) {
      socket.close(1013, 'Too many VNC sessions');
      return;
    }
    open++;
    const key = session.idHash.toString('hex');
    const now = Date.now();
    if ((lastAudit.get(key) ?? 0) < now - 10 * 60_000) {
      lastAudit.set(key, now);
      ctx.repo.audit('vnc_opened', req.ip);
    }

    let tcp: net.Socket | null = null;
    let closed = false;
    const close = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      open--;
      clearInterval(revalidate);
      unsubscribe();
      tcp?.destroy();
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    const check = () => {
      const row = ctx.repo.getSession(session.idHash);
      const t = Date.now();
      if (!row || row.expires_at <= t || row.last_seen_at + ctx.config.sessionIdleMs <= t) close(4001, 'Session ended');
    };
    const revalidate = setInterval(check, REVALIDATE_MS);
    // Close immediately when sessions are revoked instead of waiting for the next interval.
    const unsubscribe = ctx.events.subscribe((ev) => {
      if (ev.type === 'session_revoked') check();
    });

    socket.on('close', () => close());
    socket.on('error', () => close(1011));

    dns
      .lookup(ctx.config.chromiumHost, { family: 4 })
      .then(({ address }) => {
        if (closed) return;
        tcp = net.connect({ host: address, port: ctx.config.vncPort });
        tcp.setNoDelay(true);
        tcp.on('data', (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(chunk, { binary: true });
          if (socket.bufferedAmount > HIGH_WATER) {
            tcp?.pause();
            const resume = setInterval(() => {
              if (closed || socket.bufferedAmount < HIGH_WATER / 2) {
                clearInterval(resume);
                tcp?.resume();
              }
            }, 50);
          }
        });
        tcp.on('close', () => close(1011, 'VNC server closed the connection'));
        tcp.on('error', () => close(1011, 'VNC server unavailable'));
        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (!tcp || tcp.destroyed) return;
          if (!isBinary) return; // RFB is binary-only
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          tcp.write(buf);
        });
      })
      .catch(() => close(1011, 'VNC server unavailable'));
  });
}
