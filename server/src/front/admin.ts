import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminAuditEntry, AdminOverview, AdminPort, AdminUser, CreateUserResponse, ResetUserResponse, UserStatus } from '../../../shared/api.js';
import { passwordPolicyError } from '../crypto/password.js';
import { AppError, Errors } from '../errors.js';
import type { UserRow } from './db.js';
import type { Gateway } from './gateway.js';
import { Username } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 20 random characters in four groups: easy to read out loud or type from a message. */
export function generateTempPassword(): string {
  const chars = Array.from({ length: 20 }, () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]!);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

const Origin = z
  .string()
  .max(200)
  .regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, 'Origin must look like https://host[:port] (no path).');

const Port = z.number().int().min(1).max(65535);
const AdminSecret = { adminPassword: z.string().min(1).max(256), totp: z.string().max(12).optional() };

/** User management (admin only). Every route proves the caller's session with the admin's own worker first. */
export function registerAdminRoutes(app: FastifyInstance, gw: Gateway): void {
  const cfg = { config: { front: true } };

  /**
   * The caller must be the admin, on the admin's port, with a live session (and for state-changing requests the CSRF
   * token and Origin): the admin's worker checks the first two as it would for any request.
   */
  async function requireAdmin(req: FastifyRequest): Promise<UserRow> {
    const port = gw.localPort(req.raw);
    const user = gw.identify(req.headers, port, gw.secure(req));
    if (!user) throw Errors.unauthorized();
    if (user.role !== 'admin') throw Errors.forbidden();
    if (!SAFE_METHODS.has(req.method) && !gw.originAllowed(req.headers, port, gw.info(req))) throw Errors.forbidden('Cross-origin request rejected.');
    const r = SAFE_METHODS.has(req.method) ? await gw.call(user, req, 'GET', '/api/auth/whoami') : await gw.call(user, req, 'POST', '/api/auth/ping', {});
    if (r.status !== 200) throw workerError(r.status, r.body) ?? Errors.unauthorized();
    return user;
  }

  function workerError(status: number, body: Buffer): AppError | undefined {
    try {
      const e = (JSON.parse(body.toString('utf8')) as { error?: { code?: string; message?: string; retryAfter?: number } }).error;
      if (e?.code && e.message) return new AppError(status, e.code, e.message, e.retryAfter);
    } catch {
      /* not JSON */
    }
    return undefined;
  }

  /** Destructive actions ask for the admin's password (and 2FA code) again; a stolen session alone is not enough. */
  async function reauth(admin: UserRow, req: FastifyRequest, adminPassword: string, totp: string | undefined): Promise<void> {
    const r = await gw.call(admin, req, 'POST', '/api/auth/verify', { password: adminPassword, ...(totp ? { totp } : {}) });
    if (r.status === 200) return;
    throw workerError(r.status, r.body) ?? new AppError(401, 'invalid_password', 'Password is incorrect.');
  }

  async function view(u: UserRow): Promise<AdminUser> {
    let status: UserStatus = 'unknown';
    let wa: AdminUser['wa'] = null;
    try {
      const r = await gw.callInternal(u, 'GET', '/internal/info', undefined, 4000);
      if (r.status === 200) {
        const info = JSON.parse(r.body.toString('utf8')) as { hasOwner: boolean; pending: 'new' | 'reset' | null; wa: AdminUser['wa'] };
        status = info.pending === 'reset' ? 'reset' : info.pending === 'new' || !info.hasOwner ? 'pending' : 'active';
        wa = info.hasOwner ? info.wa : null;
      }
    } catch {
      /* unreachable worker: shown as unknown */
    }
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      disabled: !!u.disabled,
      port: u.role === 'admin' ? null : u.port,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      status,
      wa,
    };
  }

  function target(idParam: unknown): UserRow {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(idParam);
    const u = gw.repo.getUser(id);
    if (!u) throw Errors.notFound('User');
    return u;
  }

  function nonAdmin(u: UserRow): UserRow {
    if (u.role === 'admin') throw Errors.conflict('The admin account cannot be changed this way.');
    return u;
  }

  function validPort(port: number | null | undefined): number | null {
    if (port === null || port === undefined || port === gw.listeners.defaultPort) return null;
    if (!gw.repo.getListener(port)) throw Errors.validation('That port is not open. Open it under Ports first.');
    return port;
  }

  const audit = (event: string, req: FastifyRequest, actor: UserRow, t?: UserRow, detail?: string) =>
    gw.repo.audit(event, req.ip, { actor: actor.id, target: t?.id ?? null, detail: detail ?? null });

  /* ----------------------------------------------------------- overview */
  app.get('/api/admin/overview', cfg, async (req): Promise<AdminOverview> => {
    const admin = await requireAdmin(req);
    const users = await Promise.all(gw.repo.listUsers().map(view));
    const ports: AdminPort[] = gw.repo.listListeners().map((l) => ({
      port: l.port,
      origin: l.public_origin,
      usernames: gw.repo.usersOnPort(l.port).map((u) => u.username),
    }));
    return {
      currentUserId: admin.id,
      users,
      defaultPort: gw.listeners.defaultPort,
      defaultOrigin: gw.config.publicOrigin ?? null,
      ports,
      availablePorts: [...gw.listeners.allowedPorts()],
      maxUsers: gw.config.maxUsers,
    };
  });

  /* ------------------------------------------------------------- create */
  app.post('/api/admin/users', cfg, async (req): Promise<CreateUserResponse> => {
    const admin = await requireAdmin(req);
    const body = z.object({ username: Username, password: z.string().max(256).optional(), port: Port.nullable() }).parse(req.body);
    if (gw.repo.userCount() >= gw.config.maxUsers) throw Errors.conflict(`At most ${gw.config.maxUsers} users are allowed (MAX_USERS).`);
    const port = validPort(body.port);
    const temp = body.password || generateTempPassword();
    const policy = passwordPolicyError(temp, body.username);
    if (policy) throw Errors.validation(policy);
    const id = gw.repo.createUser({ username: body.username, role: 'user', port });
    if (id === null) throw Errors.conflict('That username is already taken.');
    const user = gw.repo.getUser(id)!;
    try {
      const r = await gw.callInternal(user, 'POST', '/internal/provision', { username: user.username, tempPassword: temp });
      if (r.status !== 200) throw workerError(r.status, r.body) ?? Errors.unavailable('The account could not be created.');
    } catch (err) {
      gw.repo.deleteUser(id);
      await gw.pool.remove(id).catch(() => undefined);
      throw err;
    }
    audit('user_created', req, admin, user, port ? `port ${port}` : 'default port');
    return { user: await view(user), temporaryPassword: temp };
  });

  /* ------------------------------------------------------------- update */
  app.patch('/api/admin/users/:id', cfg, async (req): Promise<AdminUser> => {
    const admin = await requireAdmin(req);
    const u = nonAdmin(target(req.params));
    const body = z.object({ port: Port.nullable().optional(), disabled: z.boolean().optional() }).strict().parse(req.body);
    if (body.port === undefined && body.disabled === undefined) throw Errors.validation('Nothing to change.');
    let revoke = false;
    if (body.port !== undefined) {
      const port = validPort(body.port);
      if (port !== u.port) {
        gw.repo.setPort(u.id, port);
        revoke = true;
        audit('user_port_changed', req, admin, u, port ? `port ${port}` : 'default port');
      }
    }
    if (body.disabled !== undefined && !!u.disabled !== body.disabled) {
      gw.repo.setDisabled(u.id, body.disabled);
      if (body.disabled) revoke = true;
      audit(body.disabled ? 'user_disabled' : 'user_enabled', req, admin, u);
    }
    // Sessions end now: an open stream (VNC, calls, live updates) is closed by the worker when its session goes.
    if (revoke) await gw.callInternal(u, 'POST', '/internal/revoke-sessions', {}).catch(() => undefined);
    return view(gw.repo.getUser(u.id)!);
  });

  /* -------------------------------------------------------------- reset */
  app.post('/api/admin/users/:id/reset', cfg, async (req): Promise<ResetUserResponse> => {
    const admin = await requireAdmin(req);
    const u = nonAdmin(target(req.params));
    const body = z.object({ mode: z.enum(['recovery', 'wipe']), password: z.string().max(256).optional(), ...AdminSecret }).parse(req.body);
    await reauth(admin, req, body.adminPassword, body.totp);
    const temp = body.password || generateTempPassword();
    const policy = passwordPolicyError(temp, u.username);
    if (policy) throw Errors.validation(policy);
    const info = await gw.callInternal(u, 'GET', '/internal/info');
    const claimed = info.status === 200 && (JSON.parse(info.body.toString('utf8')) as { hasOwner: boolean }).hasOwner;
    // Not claimed yet: there is no data, so a "reset" is just a fresh temporary password.
    const path = claimed ? '/internal/reset' : '/internal/provision';
    const payload = claimed ? { mode: body.mode, tempPassword: temp } : { username: u.username, tempPassword: temp };
    const r = await gw.callInternal(u, 'POST', path, payload, 180_000);
    if (r.status !== 200) throw workerError(r.status, r.body) ?? Errors.unavailable('The reset failed.');
    if (claimed && body.mode === 'wipe') {
      // The linked WhatsApp session lives in the browser profile: it goes too, or the next person would inherit it.
      await gw.pool.resetBrowser(u.id).catch((err: unknown) => gw.log.warn({ tenant: u.id, err: err instanceof Error ? err.message : String(err) }, 'browser reset failed'));
    }
    audit('user_reset', req, admin, u, claimed ? body.mode : 'new');
    return { temporaryPassword: temp, mode: claimed ? body.mode : 'new' };
  });

  /* ------------------------------------------------------------- delete */
  app.post('/api/admin/users/:id/delete', cfg, async (req) => {
    const admin = await requireAdmin(req);
    const u = nonAdmin(target(req.params));
    const body = z.object(AdminSecret).parse(req.body);
    await reauth(admin, req, body.adminPassword, body.totp);
    // Unlink the WhatsApp device first (otherwise it stays in the person's "linked devices" list), then remove everything.
    await gw.callInternal(u, 'POST', '/internal/unlink', {}, 30_000).catch(() => undefined);
    try {
      await gw.pool.remove(u.id);
    } catch {
      throw Errors.unavailable('The account could not be removed completely. Try again.');
    }
    gw.repo.deleteUser(u.id);
    audit('user_deleted', req, admin, undefined, `id ${u.id}`);
    return { ok: true };
  });

  /* -------------------------------------------------------------- ports */
  app.put('/api/admin/ports/:port', cfg, async (req) => {
    const admin = await requireAdmin(req);
    const { port } = z.object({ port: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ origin: Origin.nullable() }).strict().parse(req.body);
    if (port === gw.listeners.defaultPort) throw Errors.validation('That is the default port.');
    if (!gw.listeners.isAllowed(port)) throw Errors.validation('That port is not published. Add it to EXTRA_PORTS and publish it on the reverse proxy.');
    try {
      await gw.listeners.open(port);
    } catch (err) {
      if ((err as { code?: string }).code === 'EADDRINUSE') throw Errors.conflict('That port is already in use.');
      throw Errors.unavailable('The port could not be opened.');
    }
    gw.repo.upsertListener(port, body.origin);
    audit('port_opened', req, admin, undefined, `port ${port}`);
    return { ok: true };
  });

  app.delete('/api/admin/ports/:port', cfg, async (req) => {
    const admin = await requireAdmin(req);
    const { port } = z.object({ port: z.coerce.number().int() }).parse(req.params);
    if (!gw.repo.getListener(port)) throw Errors.notFound('Port');
    const users = gw.repo.usersOnPort(port);
    if (users.length) throw Errors.conflict(`Still used by ${users.map((u) => u.username).join(', ')}. Move them first.`);
    gw.repo.deleteListener(port);
    await gw.listeners.close(port);
    audit('port_closed', req, admin, undefined, `port ${port}`);
    return { ok: true };
  });

  /* -------------------------------------------------------------- audit */
  app.get('/api/admin/audit', cfg, async (req): Promise<AdminAuditEntry[]> => {
    await requireAdmin(req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const name = (id: number | null) => (id === null ? null : (gw.repo.getUser(id)?.username ?? `#${id}`));
    return gw.repo.listAudit(limit).map((r) => ({ id: r.id, ts: r.ts, event: r.event, actor: name(r.actor), target: name(r.target), ip: r.ip, detail: r.detail }));
  });
}
