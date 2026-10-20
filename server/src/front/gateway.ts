import crypto from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type net from 'node:net';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { NO_LOCK_STORE, Throttle } from '../auth/throttle.js';
import { derivePasswordKeys } from '../crypto/password.js';
import { BusyError } from '../crypto/primitives.js';
import { AppError, Errors } from '../errors.js';
import { PeerGuard, registerSecurityHeaders, registerStaticUi, sendError } from '../http/server.js';
import type { Logger } from '../log.js';
import type { WorkerHandle } from '../supervisor/protocol.js';
import type { FrontConfig } from './config.js';
import type { SystemRepo, UserRow } from './db.js';
import { Listeners } from './listeners.js';
import type { WorkerPool } from './pool.js';
import { callWorker, proxyStream, proxyUpgrade, upstreamHeaders, type ClientInfo, type UpstreamResult } from './proxy.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Handled by the gateway itself. Every other /api route is forwarded to the signed-in user's worker. */
    front?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_COOKIES = ['__Host-wal_session', 'wal_session'];

export function tenantCookieName(secure: boolean): string {
  return secure ? '__Host-wal_tenant' : 'wal_tenant';
}

export function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Client address / scheme / host as the trusted proxy chain reports them (same rule as Fastify's trustProxy hop count). */
export function rawClientInfo(req: IncomingMessage, hops: number): ClientInfo {
  const sock = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  const chain = [sock, ...xff];
  const ip = hops > 0 ? chain[Math.min(hops, chain.length - 1)]! : sock;
  const first = (h: string | string[] | undefined) => String(Array.isArray(h) ? h[0] : (h ?? '')).split(',')[0]!.trim();
  const proto = hops > 0 && first(req.headers['x-forwarded-proto']) ? first(req.headers['x-forwarded-proto']) : 'http';
  const host = hops > 0 && first(req.headers['x-forwarded-host']) ? first(req.headers['x-forwarded-host']) : (req.headers.host ?? '');
  return { ip, proto: proto === 'https' ? 'https' : 'http', host };
}

/** What the gateway knows and does; the route modules (auth.ts, admin.ts) and the proxy hooks are built on it. */
export class Gateway {
  readonly throttle = new Throttle(NO_LOCK_STORE);
  readonly listeners: Listeners;
  /** Burned on unknown or unusable accounts so that "no such user" takes as long as a wrong password. */
  private dummySalt = crypto.randomBytes(32);

  constructor(
    readonly config: FrontConfig,
    readonly repo: SystemRepo,
    readonly pool: WorkerPool,
    readonly log: Logger,
    makeServer: () => http.Server,
  ) {
    this.listeners = new Listeners(config.host, config.extraPorts, log, makeServer);
  }

  /* ----------------------------------------------------- listener policy */

  localPort(req: IncomingMessage): number {
    return req.socket.localPort ?? this.listeners.defaultPort;
  }

  /** The port a user signs in on. The admin is pinned to the default port. */
  userPort(user: UserRow): number {
    return user.role === 'admin' ? this.listeners.defaultPort : (user.port ?? this.listeners.defaultPort);
  }

  /** The origin browsers use on this port: the configured one for the default port, the admin's note for extra ports. */
  expectedOrigin(port: number): string | undefined {
    if (port === this.listeners.defaultPort) return this.config.publicOrigin;
    return this.repo.getListener(port)?.public_origin ?? undefined;
  }

  usable(user: UserRow | undefined, port: number): user is UserRow {
    return !!user && !user.disabled && this.userPort(user) === port;
  }

  /* ------------------------------------------------------ identification */

  secure(req: FastifyRequest): boolean {
    return this.config.cookieSecure === 'auto' ? this.info(req).proto === 'https' : this.config.cookieSecure;
  }

  /**
   * Scheme and host the worker is told. When the admin configured the origin of this port (PUBLIC_ORIGIN for the default
   * port, the port's own origin otherwise) that origin wins over whatever the proxy chain forwarded: the Origin check
   * in the worker and the cookies' Secure flag then follow the configured address, not the forwarding headers.
   */
  effective(info: ClientInfo, port: number): ClientInfo {
    const origin = this.expectedOrigin(port);
    if (!origin) return info;
    const u = new URL(origin);
    return { ip: info.ip, proto: u.protocol === 'https:' ? 'https' : 'http', host: u.host };
  }

  /** The user a request's tenant cookie points at, if that user may use this port. (The worker still checks the session.) */
  identify(headers: IncomingHttpHeaders, port: number, secure: boolean): UserRow | null {
    const raw = getCookie(headers.cookie, tenantCookieName(secure));
    if (!raw || !/^\d{1,5}$/.test(raw)) return null;
    const user = this.repo.getUser(Number(raw));
    return this.usable(user, port) ? user : null;
  }

  /** Strict Origin check for state-changing requests and WebSocket upgrades. */
  originAllowed(headers: IncomingHttpHeaders, port: number, info: ClientInfo): boolean {
    const origin = headers.origin;
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return false;
    return origin === (this.expectedOrigin(port) ?? `${info.proto}://${info.host}`);
  }

  info(req: FastifyRequest): ClientInfo {
    return this.effective({ ip: req.ip, proto: req.protocol, host: req.host }, this.localPort(req.raw));
  }

  /* -------------------------------------------------------------- worker */

  async worker(user: Pick<UserRow, 'id'>): Promise<WorkerHandle> {
    try {
      return await this.pool.ensure(user.id);
    } catch {
      throw Errors.unavailable('Your account is starting. Please try again in a moment.');
    }
  }

  /** A buffered call to a user's worker with the client's own headers (cookies, CSRF token, origin) carried over. */
  async call(
    user: UserRow,
    req: FastifyRequest,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: http.OutgoingHttpHeaders = {},
  ): Promise<UpstreamResult> {
    const handle = await this.worker(user);
    const headers = upstreamHeaders(req.headers, this.info(req), handle, { internal: path.startsWith('/internal/') });
    delete headers['content-length'];
    delete headers['content-type'];
    if (body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, extraHeaders);
    try {
      return await callWorker(handle, { method, path, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw Errors.unavailable('Your account is not reachable right now.');
    }
  }

  /** Calls the worker of a tenant without a client request (startup checks, admin actions on other users). */
  async callInternal(user: Pick<UserRow, 'id'>, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<UpstreamResult> {
    const handle = await this.worker(user);
    const headers: http.OutgoingHttpHeaders = { 'x-wal-internal': handle.internalToken, 'x-wal-scope': 'internal' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await callWorker(handle, { method, path, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
    } catch {
      throw Errors.unavailable('That account is not reachable right now.');
    }
  }

  /** Sends a worker's answer to the browser, optionally adding the tenant cookie after a sign-in. */
  relay(req: FastifyRequest, reply: FastifyReply, user: UserRow, r: UpstreamResult): FastifyReply {
    const secure = this.secure(req);
    const setCookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    let signedIn = false;
    let signedOut = false;
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (!name || !SESSION_COOKIES.includes(name.trim())) continue;
      if (value && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) signedIn = true;
      else signedOut = true;
    }
    reply.code(r.status);
    for (const [k, v] of Object.entries(r.headers)) {
      const key = k.toLowerCase();
      if (v === undefined || key === 'set-cookie' || key === 'content-length' || key === 'connection' || key === 'keep-alive' || key === 'transfer-encoding') continue;
      reply.header(k, v);
    }
    if (setCookies.length) reply.header('set-cookie', setCookies);
    const opts = { path: '/', httpOnly: true, secure, sameSite: 'strict' as const };
    if (signedIn) {
      reply.setCookie(tenantCookieName(secure), String(user.id), { ...opts, maxAge: Math.floor(this.config.sessionMaxMs / 1000) });
      this.repo.touchLogin(user.id);
    } else if (signedOut) {
      reply.clearCookie(tenantCookieName(secure), opts);
    }
    return reply.send(r.body);
  }

  /** "No such user" and "wrong password" look the same and cost the same. */
  async rejectUnknown(req: FastifyRequest, event = 'login_failed'): Promise<never> {
    this.throttle.begin(req.ip, { global: false });
    await derivePasswordKeys('dummy-password-for-timing', this.dummySalt, this.config.scryptLogN);
    this.repo.audit(event, req.ip);
    throw Errors.invalidCredentials();
  }

  requireOrigin(req: FastifyRequest): void {
    if (!this.originAllowed(req.headers, this.localPort(req.raw), this.info(req))) throw Errors.forbidden('Cross-origin request rejected.');
  }
}

/**
 * Starts listening on the default port. The port is registered before the first connection can arrive, so the very first
 * request already knows which port it came in on.
 */
export async function listenDefault(built: BuiltGateway, opts: { host: string; port: number }): Promise<number> {
  if (opts.port !== 0) built.gw.listeners.setDefault(opts.port, built.app.server);
  await built.app.listen({ host: opts.host, port: opts.port });
  const actual = (built.app.server.address() as net.AddressInfo).port;
  built.gw.listeners.setDefault(actual, built.app.server);
  return actual;
}

export interface BuiltGateway {
  app: FastifyInstance;
  gw: Gateway;
}

/** Builds the Fastify app of the gateway (routes are added by the caller: auth.ts, admin.ts). */
export async function buildGateway(config: FrontConfig, repo: SystemRepo, pool: WorkerPool, log: Logger): Promise<BuiltGateway> {
  let handler: http.RequestListener | undefined;
  const app = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    trustProxy: config.trustProxy > 0 ? (_addr: string, hop: number) => hop < config.trustProxy : false,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    routerOptions: { maxParamLength: 300 },
    return503OnClosing: true,
    // The workers log every request they serve; the gateway only logs what goes wrong.
    disableRequestLogging: true,
    // Extra ports are plain http.Servers around the same request handler.
    serverFactory: (h) => {
      handler = h;
      return http.createServer(h);
    },
  });
  const gw = new Gateway(config, repo, pool, log, () => {
    const s = http.createServer(handler!);
    s.on('upgrade', (req, socket, head) => void onUpgrade(gw, req, socket as net.Socket, head));
    return s;
  });
  app.server.on('upgrade', (req, socket, head) => void onUpgrade(gw, req, socket as net.Socket, head));
  const peerGuard = new PeerGuard(config.chromiumHost);
  app.addHook('onClose', async () => {
    peerGuard.stop();
    await gw.listeners.closeAll();
  });

  app.removeContentTypeParser('text/plain');
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx2) => Errors.rateLimited(Math.ceil(ctx2.ttl / 1000)),
  });
  registerSecurityHeaders(app, config.cookieSecure);

  /* ------------------------------------------ everything else under /api */
  app.addHook('onRequest', async (req, reply) => {
    if (peerGuard.isBlocked(req.socket.remoteAddress)) return sendError(reply, Errors.forbidden());
    if (!req.url.startsWith('/')) return sendError(reply, new AppError(400, 'bad_request', 'Bad request.'));
    if (req.routeOptions.config?.front) return;
    const path = req.url.split('?')[0] ?? '';
    // Decided from the raw path too: the router decodes percent-escapes.
    let decoded = path.toLowerCase();
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      /* keep raw */
    }
    if (!(path.toLowerCase().startsWith('/api') || decoded.startsWith('/api'))) return;
    reply.hijack();
    try {
      await forwardApi(gw, req, reply);
    } catch (err) {
      req.log.error({ err }, 'forwarding failed');
      reply.raw.destroy();
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return sendError(reply, err);
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      return sendError(reply, Errors.validation(`${where}${first?.message ?? 'Invalid request.'}`.slice(0, 200)));
    }
    if (err instanceof BusyError) return sendError(reply, Errors.busy());
    const e = err as { statusCode?: number };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      const msg = e.statusCode === 413 ? 'Request too large.' : e.statusCode === 415 ? 'Unsupported content type.' : 'Bad request.';
      return sendError(reply, new AppError(e.statusCode, 'bad_request', msg));
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, new AppError(500, 'internal', 'Internal error.'));
  });

  app.get('/healthz', { logLevel: 'silent', config: { front: true, rateLimit: false } }, async () => ({ ok: true }));
  await registerStaticUi(app, config.webDir);
  return { app, gw };
}

function rawReply(res: http.ServerResponse, status: number, err: AppError): void {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ error: { code: err.code, message: err.message } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Only plain /api/… paths are forwarded: no dot segments, doubled or encoded slashes, backslashes, control characters or
 * escapes of those. (The worker's /internal routes must stay unreachable from outside however a path is spelled.)
 */
export function cleanApiPath(url: string): boolean {
  const [path = ''] = url.split('?');
  if (!/^\/api(\/[\x21-\x7e]*)?$/.test(path)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded !== path && /%/.test(decoded)) return false; // double encoding
  return !/(^|\/)\.{1,2}(\/|$)|\/\/|\\|[\x00-\x1f\x7f]/.test(decoded) && /^\/api(\/|$)/.test(decoded);
}

/** Forwards a request of a signed-in user to that user's worker, streaming. */
async function forwardApi(gw: Gateway, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const res = reply.raw;
  if (!cleanApiPath(req.url)) {
    const e = new AppError(400, 'bad_request', 'Bad request.');
    return rawReply(res, e.statusCode, e);
  }
  const port = gw.localPort(req.raw);
  const secure = gw.secure(req);
  const user = gw.identify(req.headers, port, secure);
  if (!user) {
    // Stale or foreign tenant cookie: forget it so the UI falls back to the login page.
    const e = Errors.unauthorized();
    res.setHeader('set-cookie', `${tenantCookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    return rawReply(res, e.statusCode, e);
  }
  const info = gw.info(req);
  if (!SAFE_METHODS.has(req.method) && !gw.originAllowed(req.headers, port, info)) {
    const e = Errors.forbidden('Cross-origin request rejected.');
    return rawReply(res, e.statusCode, e);
  }
  let handle: WorkerHandle;
  try {
    handle = await gw.pool.ensure(user.id);
  } catch {
    const e = Errors.unavailable('Your account is starting. Please try again in a moment.');
    return rawReply(res, e.statusCode, e);
  }
  proxyStream(handle, req.raw, res, { headers: upstreamHeaders(req.headers, info, handle) });
}

/** WebSocket upgrades (VNC, call audio and video): same checks, then a tunnel to the worker. */
async function onUpgrade(gw: Gateway, req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
  const deny = (status: number) => {
    socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  socket.on('error', () => socket.destroy());
  try {
    const url = req.url ?? '';
    if (!cleanApiPath(url) || !url.startsWith('/api/') || String(req.headers.upgrade).toLowerCase() !== 'websocket') return deny(400);
    const port = gw.localPort(req);
    const info = gw.effective(rawClientInfo(req, gw.config.trustProxy), port);
    const secure = gw.config.cookieSecure === 'auto' ? info.proto === 'https' : gw.config.cookieSecure;
    const user = gw.identify(req.headers, port, secure);
    if (!user) return deny(401);
    if (!gw.originAllowed(req.headers, port, info)) return deny(403);
    const handle = await gw.pool.ensure(user.id);
    proxyUpgrade(handle, req, socket, head, upstreamHeaders(req.headers, info, handle, { keepUpgrade: true }));
  } catch {
    deny(502);
  }
}
