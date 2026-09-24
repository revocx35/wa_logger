import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, hotp } from './totp.js';
import { ORIGIN, PASSWORD, SETUP_TOKEN, makeHarness, type Harness } from '../testutil/harness.js';

function totpNow(secretB32: string, offsetSteps = 0): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of secretB32) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return hotp(Buffer.from(out), currentStep() + offsetSteps);
}

describe('auth', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('reports initial state without an owner', async () => {
    const c = h.client();
    const s = await c.refreshState();
    expect(s).toEqual({ hasOwner: false, authenticated: false, onboardingComplete: false });
  });

  it('gates signup behind the setup token and password policy, and allows it once', async () => {
    const c = h.client();
    let r = await c.req('POST', '/api/auth/signup', { setupToken: 'wrong-token-xxxxxxxx', username: 'owner', password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_setup_token');
    r = await c.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username: 'owner', password: 'short' });
    expect(r.status).toBe(400);
    r = await c.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username: 'x', password: PASSWORD });
    expect(r.status).toBe(400);
    const recovery = await c.signup();
    expect(recovery).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    const s = await c.refreshState();
    expect(s.authenticated).toBe(true);
    expect(s.username).toBe('owner');
    expect(s.csrfToken).toBeTruthy();
    const c2 = h.client();
    r = await c2.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username: 'other', password: PASSWORD });
    expect(r.status).toBe(409);
  });

  it('sets a hardened session cookie', async () => {
    const c = h.client();
    const r = await c.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username: 'owner', password: PASSWORD });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/^__Host-wal_session=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/i);
  });

  it('rejects cross-origin and origin-less state-changing requests', async () => {
    const c = h.client();
    let r = await c.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username: 'owner', password: PASSWORD }, { origin: 'https://evil.test' });
    expect(r.status).toBe(403);
    r = await c.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username: 'owner', password: PASSWORD }, { origin: null });
    expect(r.status).toBe(403);
    expect((await c.refreshState()).hasOwner).toBe(false);
  });

  it('requires the CSRF token on authenticated state-changing requests', async () => {
    const c = h.client();
    await c.signup();
    let r = await c.req('POST', '/api/auth/logout', {}, { csrf: null });
    expect(r.status).toBe(403);
    r = await c.req('POST', '/api/auth/logout', {}, { csrf: 'A'.repeat(43) });
    expect(r.status).toBe(403);
    r = await c.req('POST', '/api/auth/logout', {});
    expect(r.status).toBe(200);
    expect((await c.refreshState()).authenticated).toBe(false);
  });

  it('logs in, rejects bad credentials, and locks out after repeated failures', async () => {
    const owner = h.client();
    await owner.signup();
    const c = h.client();
    let r = await c.login('owner', 'wrong-password-123');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
    r = await c.login('someone', PASSWORD);
    expect(r.status).toBe(401);
    r = await c.login('OWNER', PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const other = h.client();
    for (let i = 0; i < 6; i++) {
      r = await other.login('owner', `wrong-password-${i}xx`);
    }
    // The 6th failure armed the per-IP lock: even the right password is refused now.
    r = await other.login('owner', PASSWORD);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeTruthy();
    expect(h.ctx.repo.listAudit(50).some((a) => a.event === 'login_failed')).toBe(true);
  });

  it('expires idle sessions', async () => {
    const c = h.client();
    await c.signup();
    h.ctx.repo.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 9 * 3600_000);
    const s = await c.refreshState();
    expect(s.authenticated).toBe(false);
    expect(h.ctx.repo.listSessions()).toHaveLength(0);
  });

  it('expires sessions at their absolute lifetime', async () => {
    const c = h.client();
    await c.signup();
    h.ctx.repo.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    expect((await c.refreshState()).authenticated).toBe(false);
  });

  it('rejects tampered cookies', async () => {
    const c = h.client();
    await c.signup();
    const [name, value] = c.cookie.split('=');
    const [sid] = value!.split('.');
    c.cookie = `${name}=${sid}.${'A'.repeat(43)}`;
    // A valid sid with a wrong secret matches no session.
    const r = await c.req('GET', '/api/auth/sessions');
    expect(r.status).toBe(401);
    c.cookie = `${name}=garbage`;
    expect((await c.refreshState()).authenticated).toBe(false);
  });

  it('changes the password and revokes other sessions', async () => {
    const a = h.client();
    await a.signup();
    const b = h.client();
    expect((await b.login()).status).toBe(200);
    let r = await a.req('POST', '/api/auth/password', { currentPassword: 'nope-nope-nope', newPassword: 'another-good-passphrase' });
    expect(r.status).toBe(401);
    r = await a.req('POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another-good-passphrase' });
    expect(r.status).toBe(200);
    expect((await a.refreshState()).authenticated).toBe(true);
    expect((await b.refreshState()).authenticated).toBe(false);
    expect((await h.client().login('owner', PASSWORD)).status).toBe(401);
    expect((await h.client().login('owner', 'another-good-passphrase')).status).toBe(200);
  });

  it('recovers access with the recovery key and rotates it', async () => {
    const a = h.client();
    const recovery = await a.signup();
    const c = h.client();
    let r = await c.req('POST', '/api/auth/recover', { username: 'owner', recoveryKey: 'AAAA-BBBB', newPassword: 'recovered-passphrase-1' });
    expect(r.status).toBe(401);
    r = await c.req('POST', '/api/auth/recover', { username: 'owner', recoveryKey: recovery.toLowerCase(), newPassword: 'recovered-passphrase-1' });
    expect(r.status).toBe(200);
    expect(r.body.recoveryKey).not.toBe(recovery);
    expect((await a.refreshState()).authenticated).toBe(false);
    expect((await c.refreshState()).authenticated).toBe(true);
    expect((await h.client().login('owner', 'recovered-passphrase-1')).status).toBe(200);
    // the old recovery key no longer works
    r = await h.client().req('POST', '/api/auth/recover', { username: 'owner', recoveryKey: recovery, newPassword: 'recovered-passphrase-2' });
    expect(r.status).toBe(401);
  });

  it('enrolls TOTP, requires it on login, and prevents code replay', async () => {
    const a = h.client();
    await a.signup();
    let r = await a.req('POST', '/api/auth/totp/setup', {});
    expect(r.status).toBe(200);
    const secret = r.body.secret as string;
    expect(r.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    r = await a.req('POST', '/api/auth/totp/enable', { code: totpNow(secret), password: 'wrong-password-99' });
    expect(r.status).toBe(401);
    r = await a.req('POST', '/api/auth/totp/enable', { code: '000000', password: PASSWORD });
    expect(r.status).toBe(400);
    r = await a.req('POST', '/api/auth/totp/enable', { code: totpNow(secret, -1), password: PASSWORD });
    expect(r.status).toBe(200);

    const b = h.client();
    r = await b.login();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, needTotp: true });
    expect((await b.refreshState()).authenticated).toBe(false);
    r = await b.login('owner', PASSWORD, '123456');
    expect(r.status).toBe(401);
    const code = totpNow(secret);
    r = await b.login('owner', PASSWORD, code);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    // replaying the same code fails
    r = await h.client().login('owner', PASSWORD, code);
    expect(r.status).toBe(401);

    // disabling requires password + a fresh code
    r = await b.req('POST', '/api/auth/totp/disable', { password: 'wrong-password-zz', code: totpNow(secret, 1) });
    expect(r.status).toBe(401);
    r = await b.req('POST', '/api/auth/totp/disable', { password: PASSWORD, code: totpNow(secret, 1) });
    expect(r.status).toBe(200);
    r = await h.client().login();
    expect(r.body).toEqual({ ok: true });
  });

  it('lists and revokes sessions', async () => {
    const a = h.client();
    await a.signup();
    const b = h.client();
    await b.login();
    const r = await a.req('GET', '/api/auth/sessions');
    expect(r.body).toHaveLength(2);
    const other = (r.body as { id: string; current: boolean }[]).find((s) => !s.current)!;
    expect((await a.req('DELETE', `/api/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await b.refreshState()).authenticated).toBe(false);
    expect((await a.refreshState()).authenticated).toBe(true);
  });

  it('rotates the recovery key with the password', async () => {
    const a = h.client();
    const old = await a.signup();
    let r = await a.req('POST', '/api/auth/recovery-key/rotate', { password: 'wrong-password-1' });
    expect(r.status).toBe(401);
    r = await a.req('POST', '/api/auth/recovery-key/rotate', { password: PASSWORD });
    expect(r.status).toBe(200);
    const fresh = r.body.recoveryKey as string;
    expect(fresh).not.toBe(old);
    r = await h.client().req('POST', '/api/auth/recover', { username: 'owner', recoveryKey: old, newPassword: 'recovered-passphrase-3' });
    expect(r.status).toBe(401);
    r = await h.client().req('POST', '/api/auth/recover', { username: 'owner', recoveryKey: fresh, newPassword: 'recovered-passphrase-3' });
    expect(r.status).toBe(200);
  });

  it('sets security headers', async () => {
    const r = await h.client().req('GET', '/api/state');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=/);
  });

  it('returns generic errors for malformed input', async () => {
    const c = h.client();
    let r = await c.req('POST', '/api/auth/login', { username: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation');
    r = await c.req('POST', '/api/auth/login', undefined, { headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(400);
    const raw = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://wal.test', 'content-type': 'text/plain' }, payload: 'x' });
    expect(raw.statusCode).toBe(415);
  });
});

describe('brute-force and race hardening', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('charges attempts before scrypt, so parallel guesses cannot race past the lock', async () => {
    await h.client().signup();
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => h.client().login('owner', `wrong-guess-number-${i}`)));
    const evaluated = results.filter((r) => r.status === 401).length;
    const throttled = results.filter((r) => r.status === 429).length;
    expect(evaluated).toBeLessThanOrEqual(6);
    expect(evaluated + throttled).toBe(9);
    expect((await h.client().login('owner', PASSWORD)).status).toBe(429);
  });

  it('does not let one attacker IP lock the owner out', async () => {
    await h.client().signup();
    for (let i = 0; i < 8; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '203.0.113.7',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'owner', password: `attacker-guess-${i}` }),
      });
    }
    const owner = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.9',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'owner', password: PASSWORD }),
    });
    expect(owner.statusCode).toBe(200);
  });

  it('accepts a TOTP code only once even for parallel logins', async () => {
    const a = h.client();
    await a.signup();
    const setup = await a.req('POST', '/api/auth/totp/setup', {});
    expect((await a.req('POST', '/api/auth/totp/enable', { code: totpNow(setup.body.secret, -1), password: PASSWORD })).status).toBe(200);
    const code = totpNow(setup.body.secret);
    const results = await Promise.all([h.client().login('owner', PASSWORD, code), h.client().login('owner', PASSWORD, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('requires the 2FA code for wiping when 2FA is enabled', async () => {
    const a = h.client();
    await a.signup();
    const setup = await a.req('POST', '/api/auth/totp/setup', {});
    await a.req('POST', '/api/auth/totp/enable', { code: totpNow(setup.body.secret, -1), password: PASSWORD });
    expect((await a.req('POST', '/api/data/wipe', { password: PASSWORD })).status).toBe(401);
    expect((await a.req('POST', '/api/data/wipe', { password: PASSWORD, totp: totpNow(setup.body.secret) })).status).toBe(200);
  });

  it('does not leave superseded key wraps in the WAL after a password change', async () => {
    const a = h.client();
    await a.signup();
    const before = Buffer.from(h.ctx.repo.getOwner()!.privkey_pw);
    expect((await a.req('POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase' })).status).toBe(200);
    const fs = await import('node:fs');
    const files = [h.ctx.config.dbPath, `${h.ctx.config.dbPath}-wal`].filter((f) => fs.existsSync(f));
    for (const f of files) expect(fs.readFileSync(f).includes(before), f).toBe(false);
  });
});

describe('route authorization coverage', () => {
  it('rejects anonymous access to every non-public /api route', async () => {
    const h = await makeHarness();
    try {
      const PUBLIC = new Set(['GET /api/state', 'HEAD /api/state', 'POST /api/auth/signup', 'POST /api/auth/login', 'POST /api/auth/recover']);
      const routes = h.ctx.routeTable.filter((r) => r.url.startsWith('/api/'));
      expect(routes.length).toBeGreaterThan(10);
      for (const r of routes) {
        const key = `${r.method} ${r.url}`;
        expect(r.public, `${key} public flag`).toBe(PUBLIC.has(key));
        if (r.public) continue;
        const url = r.url.replace(/:(\w+)/g, 'x');
        const payload = r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}';
        const headers = { origin: 'https://wal.test', 'content-type': 'application/json' };
        const res = await h.app.inject({ method: r.method as 'GET', url, headers, payload });
        expect(res.statusCode, key).toBe(401);
        // Percent-encoded spellings of the same route must not bypass the auth hook.
        for (const variant of [url.replace(/^\/api\//, '/%61pi/'), url.replace(/^\/api\//, '/%61%70%69/'), url.replace('/api/', '/api/%2e/')]) {
          const v = await h.app.inject({ method: r.method as 'GET', url: variant, headers, payload });
          expect(v.statusCode, `${key} via ${variant}`).toBeGreaterThanOrEqual(400);
          expect([200, 201, 204, 206]).not.toContain(v.statusCode);
        }
      }
    } finally {
      await h.close();
    }
  });
});
