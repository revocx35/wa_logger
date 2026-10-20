import type { FastifyInstance } from 'fastify';
import type net from 'node:net';
import type { VncCredentials } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';
import { requireSession } from '../http/server.js';
import { ChromiumLink } from '../wa/chromium.js';

const MAX_SESSIONS = 3;
const REVALIDATE_MS = 30_000;
const HIGH_WATER = 8 * 1024 * 1024;

/**
 * Authenticated WebSocket ↔ WebSocket bridge to this tenant's x11vnc inside the chromium container. The chromium
 * manager only opens that tunnel for this tenant's bearer token; this bridge is the only way in from the browser, and
 * it requires a valid session plus a same-origin Origin header (enforced by the global onRequest hook).
 */
export function registerVncRoutes(app: FastifyInstance, ctx: AppContext, link = ChromiumLink.fromConfig(ctx.config)): void {
  let open = 0;
  const lastAudit = new Map<string, number>();

  // The password is random per browser start and only this tenant's token can read it from the manager.
  app.get('/api/vnc/credentials', async () => {
    const res: VncCredentials = { password: await link.vncPassword().catch(() => { throw Errors.unavailable('The browser is not running yet.'); }) };
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

    let tunnel: net.Socket | null = null;
    let closed = false;
    const close = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      open--;
      clearInterval(revalidate);
      unsubscribe();
      tunnel?.destroy();
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

    const early: Buffer[] = [];
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return; // RFB is binary-only
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (tunnel && !tunnel.destroyed) tunnel.write(buf);
      else if (!tunnel && early.length < 64) early.push(buf);
    });

    link
      .openVncTunnel()
      .then((tcp) => {
        if (closed) {
          tcp.destroy();
          return;
        }
        tunnel = tcp;
        tcp.setNoDelay(true);
        for (const b of early.splice(0)) tcp.write(b);
        tcp.on('data', (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(chunk, { binary: true });
          if (socket.bufferedAmount > HIGH_WATER) {
            tcp.pause();
            const resume = setInterval(() => {
              if (closed || socket.bufferedAmount < HIGH_WATER / 2) {
                clearInterval(resume);
                tcp.resume();
              }
            }, 50);
          }
        });
        tcp.on('close', () => close(1011, 'VNC server closed the connection'));
        tcp.on('error', () => close(1011, 'VNC server unavailable'));
      })
      .catch(() => close(1011, 'VNC server unavailable'));
  });
}
