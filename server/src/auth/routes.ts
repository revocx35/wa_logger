import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  LoginResponse,
  RecoverResponse,
  RotateRecoveryKeyResponse,
  SessionInfo,
  SignupResponse,
  TotpSetupResponse,
} from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import {
  PRIVKEY_AAD,
  generateX25519,
  openSealed,
  sealToPublicKey,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '../crypto/keyring.js';
import {
  derivePasswordKeys,
  deriveRecoveryKeys,
  generateRecoveryKey,
  newSalt,
  parseRecoveryKey,
  passwordPolicyError,
  PASSWORD_MAX,
} from '../crypto/password.js';
import { CryptoError, ctEqual, x25519PrivateKeyObject } from '../crypto/primitives.js';
import type { OwnerRow } from '../db/repo.js';
import { AppError, Errors } from '../errors.js';
import { requireSession } from '../http/server.js';
import {
  clearSessionCookie,
  createSession,
  publicSessionId,
  requestMeta,
  sessionPrivateKey,
  setSessionCookie,
} from './sessions.js';
import { newTotpSecret, otpauthUrl, base32, verifyTotp } from './totp.js';

const AUTH_LIMIT = { rateLimit: { max: 10, timeWindow: '15 minutes' } };
const SENSITIVE_LIMIT = { rateLimit: { max: 20, timeWindow: '15 minutes' } };

const Username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, 'Username must be 3–32 characters: letters, digits, dot, dash, underscore.');
const Password = z.string().min(1).max(PASSWORD_MAX);

const LOCK_THRESHOLD = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;

const TOTP_CONTEXT = 'totp';
const PENDING_TOTP_TTL_MS = 10 * 60_000;

function lockoutRemainingMs(owner: OwnerRow, now: number): number {
  return owner.locked_until && owner.locked_until > now ? owner.locked_until - now : 0;
}

function recordFailure(ctx: AppContext, owner: OwnerRow, now: number): void {
  const failed = owner.failed_logins + 1;
  const lockedUntil =
    failed >= LOCK_THRESHOLD ? now + Math.min(LOCK_BASE_MS * 2 ** (failed - LOCK_THRESHOLD), LOCK_MAX_MS) : owner.locked_until;
  ctx.repo.updateOwner({ failed_logins: failed, locked_until: lockedUntil ?? null });
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, config } = ctx;
  /** Pending TOTP enrollments, keyed by session id hash (hex). Never persisted. */
  const pendingTotp = new Map<string, { secret: Buffer; expires: number }>();

  function startSession(req: FastifyRequest, reply: FastifyReply, privatePkcs8: Buffer): void {
    const { cookieValue } = createSession(repo, config, privatePkcs8, requestMeta(req));
    setSessionCookie(reply, config, cookieValue);
  }

  async function verifyPassword(owner: OwnerRow, password: string): Promise<{ ok: boolean; kek: Buffer }> {
    const keys = await derivePasswordKeys(password, owner.pw_salt, config.scryptLogN);
    return { ok: ctEqual(keys.authHash, owner.pw_auth_hash), kek: keys.kek };
  }

  /* ------------------------------------------------------------ signup */
  app.post('/api/auth/signup', { config: { public: true, skipCsrf: true, ...AUTH_LIMIT } }, async (req, reply) => {
    const body = z.object({ setupToken: z.string().max(512), username: Username, password: Password }).parse(req.body);
    if (repo.hasOwner()) throw Errors.conflict('This instance is already set up. Please log in.');
    if (!ctEqual(body.setupToken.trim(), config.setupToken)) {
      repo.audit('signup_bad_token', req.ip);
      throw new AppError(401, 'invalid_setup_token', 'Invalid setup token. Find SETUP_TOKEN in your .env file.');
    }
    const policy = passwordPolicyError(body.password, body.username);
    if (policy) throw Errors.validation(policy);

    const now = Date.now();
    const pwSalt = newSalt();
    const pw = await derivePasswordKeys(body.password, pwSalt, config.scryptLogN);
    const kp = generateX25519();
    const recovery = generateRecoveryKey();
    const recoverySalt = newSalt();
    const rk = deriveRecoveryKeys(recovery.bytes, recoverySalt);

    const created = repo.createOwner({
      username: body.username,
      pw_salt: pwSalt,
      pw_auth_hash: pw.authHash,
      public_key: kp.publicRaw,
      privkey_pw: wrapPrivateKey(pw.kek, kp.privatePkcs8, PRIVKEY_AAD.password),
      privkey_recovery: wrapPrivateKey(rk.kek, kp.privatePkcs8, PRIVKEY_AAD.recovery),
      recovery_salt: recoverySalt,
      recovery_auth_hash: rk.authHash,
      created_at: now,
      password_changed_at: now,
    });
    if (!created) throw Errors.conflict('This instance is already set up. Please log in.');
    repo.audit('signup', req.ip);
    startSession(req, reply, kp.privatePkcs8);
    kp.privatePkcs8.fill(0);
    pw.kek.fill(0);
    rk.kek.fill(0);
    void ctx.wa.start().catch((err) => req.log.error({ err }, 'failed to start WhatsApp client'));
    const res: SignupResponse = { recoveryKey: recovery.display };
    return res;
  });

  /* ------------------------------------------------------------- login */
  app.post('/api/auth/login', { config: { public: true, skipCsrf: true, ...AUTH_LIMIT } }, async (req, reply) => {
    const body = z
      .object({ username: z.string().max(64), password: Password, totp: z.string().max(12).optional() })
      .parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.invalidCredentials();
    const now = Date.now();
    const locked = lockoutRemainingMs(owner, now);
    if (locked > 0) throw Errors.rateLimited(locked / 1000);

    const { ok, kek } = await verifyPassword(owner, body.password);
    const userOk = ctEqual(body.username.trim().toLowerCase(), owner.username.toLowerCase());
    if (!ok || !userOk) {
      recordFailure(ctx, owner, now);
      repo.audit('login_failed', req.ip);
      throw Errors.invalidCredentials();
    }

    const privatePkcs8 = unwrapPrivateKey(kek, owner.privkey_pw, PRIVKEY_AAD.password);
    kek.fill(0);
    try {
      if (owner.totp_enabled && owner.totp_secret_enc) {
        if (!body.totp) {
          const res: LoginResponse = { ok: false, needTotp: true };
          return res;
        }
        const secret = openSealed(x25519PrivateKeyObject(privatePkcs8), owner.totp_secret_enc, TOTP_CONTEXT);
        const step = verifyTotp(secret, body.totp, owner.totp_last_step);
        secret.fill(0);
        if (step === null) {
          recordFailure(ctx, owner, now);
          repo.audit('login_failed_totp', req.ip);
          throw new AppError(401, 'invalid_totp', 'Invalid authentication code.');
        }
        repo.updateOwner({ totp_last_step: step });
      }
      repo.updateOwner({ failed_logins: 0, locked_until: null });
      repo.audit('login', req.ip);
      startSession(req, reply, privatePkcs8);
    } finally {
      privatePkcs8.fill(0);
    }
    const res: LoginResponse = { ok: true };
    return res;
  });

  /* ------------------------------------------------------------ logout */
  app.post('/api/auth/logout', async (req, reply) => {
    const s = requireSession(req);
    repo.deleteSession(s.idHash);
    pendingTotp.delete(s.idHash.toString('hex'));
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    requireSession(req);
    const n = repo.deleteAllSessions();
    pendingTotp.clear();
    repo.audit('logout_all', req.ip, `${n} sessions`);
    ctx.events.emit({ type: 'session_revoked' });
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  /* ---------------------------------------------------------- recovery */
  app.post('/api/auth/recover', { config: { public: true, skipCsrf: true, ...AUTH_LIMIT } }, async (req, reply) => {
    const body = z
      .object({ username: z.string().max(64), recoveryKey: z.string().max(200), newPassword: Password })
      .parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.invalidCredentials();
    const now = Date.now();
    const locked = lockoutRemainingMs(owner, now);
    if (locked > 0) throw Errors.rateLimited(locked / 1000);

    const bytes = parseRecoveryKey(body.recoveryKey);
    const rk = bytes ? deriveRecoveryKeys(bytes, owner.recovery_salt) : null;
    const userOk = ctEqual(body.username.trim().toLowerCase(), owner.username.toLowerCase());
    if (!rk || !ctEqual(rk.authHash, owner.recovery_auth_hash) || !userOk) {
      recordFailure(ctx, owner, now);
      repo.audit('recover_failed', req.ip);
      throw new AppError(401, 'invalid_recovery', 'Invalid username or recovery key.');
    }
    const policy = passwordPolicyError(body.newPassword, owner.username);
    if (policy) throw Errors.validation(policy);

    let privatePkcs8: Buffer;
    try {
      privatePkcs8 = unwrapPrivateKey(rk.kek, owner.privkey_recovery, PRIVKEY_AAD.recovery);
    } catch (e) {
      if (e instanceof CryptoError) throw new AppError(500, 'internal', 'Recovery data is corrupted.');
      throw e;
    }
    const pwSalt = newSalt();
    const pw = await derivePasswordKeys(body.newPassword, pwSalt, config.scryptLogN);
    const recovery = generateRecoveryKey();
    const recoverySalt = newSalt();
    const newRk = deriveRecoveryKeys(recovery.bytes, recoverySalt);
    repo.transaction(() => {
      repo.updateOwner({
        pw_salt: pwSalt,
        pw_auth_hash: pw.authHash,
        privkey_pw: wrapPrivateKey(pw.kek, privatePkcs8, PRIVKEY_AAD.password),
        privkey_recovery: wrapPrivateKey(newRk.kek, privatePkcs8, PRIVKEY_AAD.recovery),
        recovery_salt: recoverySalt,
        recovery_auth_hash: newRk.authHash,
        totp_enabled: 0,
        totp_secret_enc: null,
        totp_last_step: null,
        failed_logins: 0,
        locked_until: null,
        password_changed_at: now,
      });
      repo.deleteAllSessions();
    });
    pendingTotp.clear();
    repo.audit('recovered', req.ip, 'password reset with recovery key; 2FA disabled; all sessions revoked');
    ctx.events.emit({ type: 'session_revoked' });
    startSession(req, reply, privatePkcs8);
    privatePkcs8.fill(0);
    const res: RecoverResponse = { recoveryKey: recovery.display };
    return res;
  });

  /* --------------------------------------------------- password change */
  app.post('/api/auth/password', { config: SENSITIVE_LIMIT }, async (req) => {
    const s = requireSession(req);
    const body = z.object({ currentPassword: Password, newPassword: Password }).parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    const now = Date.now();
    const locked = lockoutRemainingMs(owner, now);
    if (locked > 0) throw Errors.rateLimited(locked / 1000);
    const cur = await verifyPassword(owner, body.currentPassword);
    if (!cur.ok) {
      recordFailure(ctx, owner, now);
      repo.audit('password_change_failed', req.ip);
      throw new AppError(401, 'invalid_password', 'Current password is incorrect.');
    }
    const policy = passwordPolicyError(body.newPassword, owner.username);
    if (policy) throw Errors.validation(policy);
    const privatePkcs8 = unwrapPrivateKey(cur.kek, owner.privkey_pw, PRIVKEY_AAD.password);
    const pwSalt = newSalt();
    const pw = await derivePasswordKeys(body.newPassword, pwSalt, config.scryptLogN);
    repo.transaction(() => {
      repo.updateOwner({
        pw_salt: pwSalt,
        pw_auth_hash: pw.authHash,
        privkey_pw: wrapPrivateKey(pw.kek, privatePkcs8, PRIVKEY_AAD.password),
        failed_logins: 0,
        locked_until: null,
        password_changed_at: now,
      });
      repo.deleteAllSessions(s.idHash);
    });
    privatePkcs8.fill(0);
    repo.audit('password_changed', req.ip, 'other sessions revoked');
    ctx.events.emit({ type: 'session_revoked' });
    return { ok: true };
  });

  /* ---------------------------------------------------------- sessions */
  app.get('/api/auth/sessions', async (req) => {
    const s = requireSession(req);
    const list: SessionInfo[] = repo.listSessions().map((r) => ({
      id: publicSessionId(r.id_hash),
      current: r.id_hash.equals(s.idHash),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: Math.min(r.expires_at, r.last_seen_at + config.sessionIdleMs),
      ip: r.ip,
      userAgent: r.user_agent,
    }));
    return list;
  });

  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    const s = requireSession(req);
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }).parse(req.params);
    const n = repo.deleteSessionByPrefix(id);
    if (n === 0) throw Errors.notFound('Session');
    repo.audit('session_revoked', req.ip);
    ctx.events.emit({ type: 'session_revoked' });
    if (publicSessionId(s.idHash) === id) clearSessionCookie(reply, config);
    return { ok: true };
  });

  /* -------------------------------------------------------------- TOTP */
  app.post('/api/auth/totp/setup', { config: SENSITIVE_LIMIT }, async (req) => {
    const s = requireSession(req);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    if (owner.totp_enabled) throw Errors.conflict('Two-factor authentication is already enabled.');
    const now = Date.now();
    for (const [k, v] of pendingTotp) if (v.expires < now) pendingTotp.delete(k);
    const secret = newTotpSecret();
    pendingTotp.set(s.idHash.toString('hex'), { secret, expires: now + PENDING_TOTP_TTL_MS });
    const res: TotpSetupResponse = { secret: base32(secret), otpauthUrl: otpauthUrl(secret, owner.username) };
    return res;
  });

  app.post('/api/auth/totp/enable', { config: SENSITIVE_LIMIT }, async (req) => {
    const s = requireSession(req);
    const { code } = z.object({ code: z.string().max(12) }).parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    const pending = pendingTotp.get(s.idHash.toString('hex'));
    if (!pending || pending.expires < Date.now()) throw Errors.validation('Enrollment expired. Start again.');
    const step = verifyTotp(pending.secret, code, null);
    if (step === null) throw new AppError(400, 'invalid_totp', 'Invalid authentication code. Check your device clock.');
    repo.updateOwner({
      totp_secret_enc: sealToPublicKey(owner.public_key, pending.secret, TOTP_CONTEXT),
      totp_enabled: 1,
      totp_last_step: step,
    });
    pending.secret.fill(0);
    pendingTotp.delete(s.idHash.toString('hex'));
    repo.audit('totp_enabled', req.ip);
    return { ok: true };
  });

  app.post('/api/auth/totp/disable', { config: SENSITIVE_LIMIT }, async (req) => {
    const s = requireSession(req);
    const body = z.object({ password: Password, code: z.string().max(12) }).parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    if (!owner.totp_enabled || !owner.totp_secret_enc) throw Errors.conflict('Two-factor authentication is not enabled.');
    const now = Date.now();
    const locked = lockoutRemainingMs(owner, now);
    if (locked > 0) throw Errors.rateLimited(locked / 1000);
    const cur = await verifyPassword(owner, body.password);
    cur.kek.fill(0);
    const pk = sessionPrivateKey(s);
    const secret = openSealed(x25519PrivateKeyObject(pk), owner.totp_secret_enc, TOTP_CONTEXT);
    pk.fill(0);
    const step = cur.ok ? verifyTotp(secret, body.code, owner.totp_last_step) : null;
    secret.fill(0);
    if (!cur.ok || step === null) {
      recordFailure(ctx, owner, now);
      repo.audit('totp_disable_failed', req.ip);
      throw new AppError(401, 'invalid_credentials', 'Invalid password or authentication code.');
    }
    repo.updateOwner({ totp_enabled: 0, totp_secret_enc: null, totp_last_step: null, failed_logins: 0 });
    repo.audit('totp_disabled', req.ip);
    return { ok: true };
  });

  /* ------------------------------------------------ recovery key rotate */
  app.post('/api/auth/recovery-key/rotate', { config: SENSITIVE_LIMIT }, async (req) => {
    requireSession(req);
    const body = z.object({ password: Password }).parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    const now = Date.now();
    const locked = lockoutRemainingMs(owner, now);
    if (locked > 0) throw Errors.rateLimited(locked / 1000);
    const cur = await verifyPassword(owner, body.password);
    if (!cur.ok) {
      recordFailure(ctx, owner, now);
      repo.audit('recovery_rotate_failed', req.ip);
      throw new AppError(401, 'invalid_password', 'Password is incorrect.');
    }
    const privatePkcs8 = unwrapPrivateKey(cur.kek, owner.privkey_pw, PRIVKEY_AAD.password);
    cur.kek.fill(0);
    const recovery = generateRecoveryKey();
    const recoverySalt = newSalt();
    const rk = deriveRecoveryKeys(recovery.bytes, recoverySalt);
    repo.updateOwner({
      privkey_recovery: wrapPrivateKey(rk.kek, privatePkcs8, PRIVKEY_AAD.recovery),
      recovery_salt: recoverySalt,
      recovery_auth_hash: rk.authHash,
      failed_logins: 0,
    });
    privatePkcs8.fill(0);
    repo.audit('recovery_key_rotated', req.ip);
    const res: RotateRecoveryKeyResponse = { recoveryKey: recovery.display };
    return res;
  });

}
