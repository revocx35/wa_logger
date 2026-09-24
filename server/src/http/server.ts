import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError } from '../../../shared/api.js';
import { cookieName, csrfTokenFor, loadSession, sessionReader, type ActiveSession } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import type { DataReader } from '../crypto/keyring.js';
import { BusyError, ctEqual } from '../crypto/primitives.js';
import { AppError, Errors } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: ActiveSession | null;
    /** Request-scoped decryptor (lazily created from the session; disposed after the response). */
    readerInstance: DataReader | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without a session. Default: false (every /api route requires auth). */
    public?: boolean;
    /** Skip the CSRF token check (only for unauthenticated auth endpoints). */
    skipCsrf?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a request targets the API. Decided from the *matched route* (the router percent-decodes
 * the path, so a raw-URL prefix check could be bypassed with e.g. "/%61pi/..."), falling back to the
 * decoded path for unmatched requests.
 */
export function isApiRequest(req: FastifyRequest): boolean {
  const route = req.routeOptions.url;
  if (route) return route.startsWith('/api/') || route === '/api';
  const raw = (req.url.split('?')[0] ?? '').toLowerCase();
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* malformed escapes: keep raw */
  }
  return raw.startsWith('/api') || decoded.startsWith('/api');
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
].join('; ');

const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(self), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), ' +
  'gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(self), ' +
  'publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(self)';

export function sendError(reply: FastifyReply, err: AppError): FastifyReply {
  const body: ApiError = { error: { code: err.code, message: err.message } };
  if (err.retryAfter) {
    body.error.retryAfter = err.retryAfter;
    reply.header('Retry-After', String(err.retryAfter));
  }
  return reply.code(err.statusCode).type('application/json; charset=utf-8').send(body);
}

export function requireSession(req: FastifyRequest): ActiveSession {
  if (!req.session) throw Errors.unauthorized();
  return req.session;
}

export function getReader(ctx: AppContext, req: FastifyRequest): DataReader {
  if (!req.readerInstance) req.readerInstance = sessionReader(ctx.repo, requireSession(req));
  return req.readerInstance;
}

export function expectedOrigin(ctx: AppContext, req: FastifyRequest): string {
  return ctx.config.publicOrigin ?? `${req.protocol}://${req.host}`;
}

export function originAllowed(ctx: AppContext, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return false;
  return origin === expectedOrigin(ctx, req);
}

/**
 * The Chromium container shares the backend network with the app (the app drives it over CDP), so a
 * compromised page inside Chromium could otherwise send requests to the app. Requests whose TCP peer
 * is the Chromium container are refused outright. Loopback is never blocked (healthchecks).
 */
class PeerGuard {
  private blocked = new Set<string>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly host: string) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    try {
      const addrs = await dns.lookup(this.host, { all: true });
      this.blocked = new Set(addrs.map((a) => a.address).filter((a) => !/^(127\.|::1$|::ffff:127\.)/.test(a)));
    } catch {
      /* not resolvable (dev/tests): nothing to block */
    }
  }

  isBlocked(remote: string | undefined): boolean {
    if (!remote || this.blocked.size === 0) return false;
    return this.blocked.has(remote.replace(/^::ffff:/, ''));
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const peerGuard = new PeerGuard(config.chromiumHost);
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    // Trust exactly one hop (Caddy): the client address is the last X-Forwarded-For entry, which
    // Caddy sets itself — a client-supplied X-Forwarded-For cannot spoof it.
    trustProxy: config.trustProxy ? (_addr: string, hop: number) => hop === 0 : false,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    routerOptions: { maxParamLength: 300 },
    return503OnClosing: true,
  });

  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) ctx.routeTable.push({ method: m, url: r.url, public: !!r.config?.public });
  });

  // Only JSON bodies are accepted (text/plain is a CORS "simple request" type — refuse it outright).
  app.removeContentTypeParser('text/plain');

  app.decorateRequest('session', null);
  app.decorateRequest('readerInstance', null);

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx2) => Errors.rateLimited(Math.ceil(ctx2.ttl / 1000)),
  });

  /* ------------------------------------------------ security headers */
  app.addHook('onSend', async (req, reply, payload) => {
    // Routes may set a stricter CSP (e.g. media responses use a sandbox policy).
    if (!reply.hasHeader('content-security-policy')) reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Origin-Agent-Cluster', '?1');
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (isApiRequest(req)) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    reply.removeHeader('X-Powered-By');
    return payload;
  });

  /* ------------------------------------ origin, session, auth, CSRF */
  app.addHook('onRequest', async (req, reply) => {
    if (peerGuard.isBlocked(req.socket.remoteAddress)) {
      return sendError(reply, Errors.forbidden());
    }
    // Only origin-form request targets ("/path"); absolute-form ("http://host/path") is refused.
    if (!req.url.startsWith('/')) return sendError(reply, new AppError(400, 'bad_request', 'Bad request.'));
    if (!isApiRequest(req)) return;
    const routeCfg = req.routeOptions.config ?? {};
    const isWs = req.headers.upgrade?.toLowerCase() === 'websocket';

    // Cross-site request protection: every state-changing request (and every WebSocket
    // upgrade) must come from our own origin.
    if ((!SAFE_METHODS.has(req.method) || isWs) && !originAllowed(ctx, req)) {
      return sendError(reply, Errors.forbidden('Cross-origin request rejected.'));
    }

    req.session = loadSession(ctx.repo, config, req.cookies[cookieName(config.cookieSecure)], req.ip ?? null);

    if (!routeCfg.public && !req.session) {
      return sendError(reply, Errors.unauthorized());
    }

    if (req.session && !SAFE_METHODS.has(req.method) && !routeCfg.skipCsrf) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !ctEqual(token, csrfTokenFor(req.session.secret))) {
        return sendError(reply, Errors.forbidden('Missing or invalid CSRF token. Reload the page.'));
      }
    }
  });

  // Second, independent layer: after routing, every matched /api route that is not explicitly
  // public must have a session — regardless of how the URL was spelled.
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    if (route?.startsWith('/api/') && !req.routeOptions.config?.public && !req.session) {
      return sendError(reply, Errors.unauthorized());
    }
  });

  app.addHook('onClose', async () => peerGuard.stop());

  app.addHook('onResponse', async (req) => {
    req.readerInstance?.dispose();
    req.readerInstance = null;
  });

  /* --------------------------------------------------------- errors */
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return sendError(reply, err);
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      return sendError(reply, Errors.validation(`${where}${first?.message ?? 'Invalid request.'}`.slice(0, 200)));
    }
    if (err instanceof BusyError) return sendError(reply, Errors.busy());
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      const msg =
        e.statusCode === 413 ? 'Request too large.' : e.statusCode === 415 ? 'Unsupported content type.' : 'Bad request.';
      return sendError(reply, new AppError(e.statusCode, 'bad_request', msg));
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, new AppError(500, 'internal', 'Internal error.'));
  });

  /* ---------------------------------------------------- health check */
  app.get('/healthz', { logLevel: 'silent', config: { public: true, rateLimit: false } }, async () => ({ ok: true }));

  /* ------------------------------------------------ static web UI */
  const webDir = config.webDir;
  const indexHtml = webDir && fs.existsSync(path.join(webDir, 'index.html')) ? fs.readFileSync(path.join(webDir, 'index.html')) : null;
  if (webDir && indexHtml) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      index: false,
      wildcard: false,
      dotfiles: 'deny',
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    // Unknown API routes and missing build assets are real 404s; everything else is an SPA route.
    if (isApiRequest(req) || req.url.startsWith('/assets/') || req.method !== 'GET' || !indexHtml) {
      return sendError(reply, Errors.notFound('Route'));
    }
    return reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml);
  });

  return app;
}
