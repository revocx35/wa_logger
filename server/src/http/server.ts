import crypto from 'node:crypto';
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

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    trustProxy: config.trustProxy,
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
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    reply.removeHeader('X-Powered-By');
    return payload;
  });

  /* ------------------------------------ origin, session, auth, CSRF */
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
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
  app.get('/healthz', { config: { public: true, rateLimit: false } }, async () => ({ ok: true }));

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
    if (req.url.startsWith('/api/') || req.method !== 'GET' || !indexHtml) {
      return sendError(reply, Errors.notFound('Route'));
    }
    return reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml);
  });

  return app;
}
