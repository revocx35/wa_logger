import type { FastifyReply, FastifyRequest } from 'fastify';
import { PRIVKEY_AAD, unwrapPrivateKey, wrapPrivateKey, DataReader } from '../crypto/keyring.js';
import { hkdf, hmacSha256, randomBytes, sha256 } from '../crypto/primitives.js';
import type { Repo, SessionRow } from '../db/repo.js';

/*
 * Cookie value: b64url(sid 32B) "." b64url(secret 32B)
 *   DB key      = sha256(sid ‖ secret)            — a DB dump cannot be turned back into a cookie, and a
 *                                                 cookie with a valid sid but altered secret matches nothing
 *   privkey_enc = AES-GCM(HKDF(secret,"session"))  — a DB dump cannot unlock the owner's private key
 *   CSRF token  = HMAC(HKDF(secret,"csrf"),"csrf") — bound to the session, never stored
 */

const EMPTY = Buffer.alloc(0);
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionConfig {
  cookieSecure: boolean;
  sessionIdleMs: number;
  sessionMaxMs: number;
}

export interface ActiveSession {
  idHash: Buffer;
  secret: Buffer;
  row: SessionRow;
}

export function cookieName(secure: boolean): string {
  return secure ? '__Host-wal_session' : 'wal_session';
}

function sessionKey(secret: Buffer): Buffer {
  return hkdf(secret, EMPTY, 'wal/v1/session');
}

export function csrfTokenFor(secret: Buffer): string {
  return hmacSha256(hkdf(secret, EMPTY, 'wal/v1/csrf'), 'csrf').toString('base64url');
}

export function publicSessionId(idHash: Buffer): string {
  return idHash.toString('hex').slice(0, 16);
}

export function createSession(
  repo: Repo,
  cfg: SessionConfig,
  privatePkcs8: Buffer,
  meta: { ip: string | null; userAgent: string | null },
  now = Date.now(),
): { cookieValue: string; idHash: Buffer; secret: Buffer } {
  const sid = randomBytes(32);
  const secret = randomBytes(32);
  const idHash = sha256(Buffer.concat([sid, secret]));
  repo.insertSession({
    id_hash: idHash,
    privkey_enc: wrapPrivateKey(sessionKey(secret), privatePkcs8, PRIVKEY_AAD.session),
    created_at: now,
    last_seen_at: now,
    expires_at: now + cfg.sessionMaxMs,
    ip: meta.ip,
    user_agent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
  });
  return { cookieValue: `${sid.toString('base64url')}.${secret.toString('base64url')}`, idHash, secret };
}

export function parseCookieValue(value: string | undefined): { sid: Buffer; secret: Buffer } | null {
  if (!value || value.length > 120) return null;
  const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return null;
  const sid = Buffer.from(m[1]!, 'base64url');
  const secret = Buffer.from(m[2]!, 'base64url');
  if (sid.length !== 32 || secret.length !== 32) return null;
  return { sid, secret };
}

/** Validates the cookie, enforces idle/absolute expiry and refreshes last_seen (throttled). */
export function loadSession(
  repo: Repo,
  cfg: SessionConfig,
  cookieValue: string | undefined,
  ip: string | null,
  now = Date.now(),
): ActiveSession | null {
  const parsed = parseCookieValue(cookieValue);
  if (!parsed) return null;
  const idHash = sha256(Buffer.concat([parsed.sid, parsed.secret]));
  const row = repo.getSession(idHash);
  if (!row) return null;
  if (row.expires_at <= now || row.last_seen_at + cfg.sessionIdleMs <= now) {
    repo.deleteSession(idHash);
    return null;
  }
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    repo.touchSession(idHash, now, ip);
    row.last_seen_at = now;
  }
  return { idHash, secret: parsed.secret, row };
}

/** Unlocks the owner's private key using the session secret from the cookie. */
export function sessionPrivateKey(s: ActiveSession): Buffer {
  return unwrapPrivateKey(sessionKey(s.secret), s.row.privkey_enc, PRIVKEY_AAD.session);
}

export function sessionReader(repo: Repo, s: ActiveSession): DataReader {
  const pk = sessionPrivateKey(s);
  try {
    return DataReader.fromPkcs8(repo, pk);
  } finally {
    pk.fill(0);
  }
}

export function setSessionCookie(reply: FastifyReply, cfg: SessionConfig, value: string): void {
  reply.setCookie(cookieName(cfg.cookieSecure), value, {
    path: '/',
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'strict',
    maxAge: Math.floor(cfg.sessionMaxMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, cfg: SessionConfig): void {
  reply.clearCookie(cookieName(cfg.cookieSecure), { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict' });
}

export function requestMeta(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null };
}
