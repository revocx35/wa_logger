import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { requireSession } from '../http/server.js';

const HEARTBEAT_MS = 20_000;
const REVALIDATE_MS = 30_000;
const MAX_STREAMS = 10;

/**
 * Server-Sent Events. Events carry only ids/states (no content), so nothing here is decrypted.
 * The stream re-checks its session periodically and closes when the session is revoked/expired.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  let open = 0;

  app.get('/api/events', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const session = requireSession(req);
    if (open >= MAX_STREAMS) {
      return reply.code(503).send({ error: { code: 'busy', message: 'Too many open event streams.' } });
    }
    open++;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (ev: ServerEvent) => {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    send({ type: 'wa_state', status: ctx.wa.status() });

    const unsubscribe = ctx.events.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const revalidate = setInterval(() => {
      const row = ctx.repo.getSession(session.idHash);
      const now = Date.now();
      if (!row || row.expires_at <= now || row.last_seen_at + ctx.config.sessionIdleMs <= now) {
        send({ type: 'session_revoked' });
        res.end();
      }
    }, REVALIDATE_MS);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      open--;
      unsubscribe();
      clearInterval(heartbeat);
      clearInterval(revalidate);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  });
}
