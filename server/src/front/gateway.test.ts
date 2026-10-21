import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminOverview, CreateUserResponse, ResetUserResponse } from '../../../shared/api.js';
import { Browser, makeGateway, SETUP, type TestGateway } from './testutil.js';
import { cleanApiPath, rawClientInfo } from './gateway.js';

const ADMIN_PW = 'correct-horse-battery-staple-1';
const FRIEND_PW = 'my-very-own-passphrase-1';
const PORT_A = 38101;

describe('gateway: multi-user', () => {
  let g: TestGateway;
  let admin: Browser;

  async function setupAdmin(): Promise<Browser> {
    const b = new Browser(g.port);
    const r = await b.req('POST', '/api/auth/signup', { setupToken: SETUP, username: 'admin', password: ADMIN_PW });
    expect(r.status).toBe(200);
    await b.state();
    return b;
  }

  async function createUser(username: string, port: number | null = null): Promise<CreateUserResponse> {
    const r = await admin.req('POST', '/api/admin/users', { username, port });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as CreateUserResponse;
  }

  /** Temporary password → own password, as the invited person does on first sign-in. */
  async function claim(b: Browser, username: string, temp: string, pw = FRIEND_PW, port?: number): Promise<void> {
    const login = await b.req('POST', '/api/auth/login', { username, password: temp }, { port });
    expect(login.body).toMatchObject({ ok: false, mustChangePassword: true });
    const r = await b.req('POST', '/api/auth/claim', { username, password: temp, newPassword: pw }, { port });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await b.state({ port });
  }

  beforeEach(async () => {
    g = await makeGateway({ extraPorts: [PORT_A, PORT_A + 1, PORT_A + 2] });
    admin = await setupAdmin();
  });
  afterEach(async () => {
    await g.close();
  });

  describe('first-time setup', () => {
    it('offers setup until the admin exists, requires the setup token and closes afterwards', async () => {
      await g.close();
      g = await makeGateway();
      const b = new Browser(g.port);
      expect(await b.state()).toEqual({ hasOwner: false, authenticated: false, onboardingComplete: false });
      const bad = await b.req('POST', '/api/auth/signup', { setupToken: 'wrong-token-xxxxxxxx', username: 'admin', password: ADMIN_PW });
      expect(bad.status).toBe(401);
      expect(g.repo.userCount()).toBe(0);
      const weak = await b.req('POST', '/api/auth/signup', { setupToken: SETUP, username: 'admin', password: 'short' });
      expect(weak.status).toBe(400);
      expect(g.repo.userCount()).toBe(0); // a failed signup must not leave a half-created admin behind
      const ok = await b.req('POST', '/api/auth/signup', { setupToken: SETUP, username: 'admin', password: ADMIN_PW });
      expect(ok.status).toBe(200);
      expect(ok.body.recoveryKey).toBeTruthy();
      expect([...b.jar.keys()].sort()).toEqual(['wal_session', 'wal_tenant']);
      const st = await b.state();
      expect(st).toMatchObject({ hasOwner: true, authenticated: true, username: 'admin', role: 'admin' });
      expect(g.repo.getUser(1)).toMatchObject({ username: 'admin', role: 'admin' });
      const again = await new Browser(g.port).req('POST', '/api/auth/signup', { setupToken: SETUP, username: 'other', password: ADMIN_PW });
      expect(again.status).toBe(409);
    });

    it('never offers setup on an extra port', async () => {
      await g.close();
      g = await makeGateway({ extraPorts: [PORT_A] });
      expect((await new Browser(g.port).state()).hasOwner).toBe(false);
      // Open the extra port without an admin (only possible through the repo here) and look at it from there.
      g.repo.upsertListener(PORT_A, null);
      await g.gw.listeners.open(PORT_A);
      const b = new Browser(PORT_A);
      expect((await b.state()).hasOwner).toBe(true);
      const r = await b.req('POST', '/api/auth/signup', { setupToken: SETUP, username: 'admin', password: ADMIN_PW });
      expect(r.status).toBe(404);
    });
  });

  describe('creating users', () => {
    it('lets only the admin create users, hands out a temporary password once, and rejects duplicates', async () => {
      const made = await createUser('friend');
      expect(made.temporaryPassword).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
      expect(made.user).toMatchObject({ username: 'friend', role: 'user', status: 'pending', port: null, disabled: false });
      expect((await admin.req('POST', '/api/admin/users', { username: 'FRIEND', port: null })).status).toBe(409);
      expect((await admin.req('POST', '/api/admin/users', { username: 'x', port: null })).status).toBe(400);
      expect((await admin.req('POST', '/api/admin/users', { username: 'weakpw', password: 'short', port: null })).status).toBe(400);
      // Without the CSRF token / from another origin / without a session: nothing happens.
      expect((await admin.req('POST', '/api/admin/users', { username: 'a1b2c3', port: null }, { csrf: false })).status).toBe(403);
      expect((await admin.req('POST', '/api/admin/users', { username: 'a1b2c3', port: null }, { origin: 'http://evil.test' })).status).toBe(403);
      expect((await new Browser(g.port).req('POST', '/api/admin/users', { username: 'a1b2c3', port: null })).status).toBe(401);
      expect(g.repo.listUsers().map((u) => u.username)).toEqual(['admin', 'friend']);
      const ov = (await admin.req('GET', '/api/admin/overview')).body as AdminOverview;
      expect(ov.users.map((u) => [u.username, u.status])).toEqual([['admin', 'active'], ['friend', 'pending']]);
      expect(JSON.stringify(ov)).not.toContain(made.temporaryPassword);
    });

    it('enforces MAX_USERS', async () => {
      await g.close();
      g = await makeGateway({ maxUsers: 2 });
      admin = await setupAdmin();
      await createUser('friend');
      expect((await admin.req('POST', '/api/admin/users', { username: 'third', port: null })).status).toBe(409);
    });

    it('keeps users out of the admin API', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      expect(await friend.state()).toMatchObject({ authenticated: true, role: 'user', username: 'friend' });
      for (const [m, p, body] of [
        ['GET', '/api/admin/overview', undefined],
        ['GET', '/api/admin/audit', undefined],
        ['POST', '/api/admin/users', { username: 'sneaky', port: null }],
        ['PATCH', '/api/admin/users/1', { disabled: true }],
        ['POST', '/api/admin/users/1/reset', { mode: 'wipe', adminPassword: ADMIN_PW }],
        ['POST', '/api/admin/users/1/delete', { adminPassword: ADMIN_PW }],
        ['PUT', `/api/admin/ports/${PORT_A}`, { origin: null }],
      ] as const) {
        expect((await friend.req(m, p, body)).status, `${m} ${p}`).toBe(403);
      }
      expect(g.repo.listUsers().map((u) => u.username)).toEqual(['admin', 'friend']);
    });
  });

  describe('first sign-in with the temporary password', () => {
    it('forces a new password, gives the user their own keys and logs the admin out of nothing', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      // Wrong password and unknown user get the same answer.
      const wrong = await friend.req('POST', '/api/auth/login', { username: 'friend', password: 'not-the-one-xxxxxx' });
      const nobody = await friend.req('POST', '/api/auth/login', { username: 'nobody', password: 'not-the-one-xxxxxx' });
      expect(wrong.status).toBe(401);
      expect(nobody.status).toBe(401);
      expect(nobody.body).toEqual(wrong.body);
      expect((await friend.req('GET', '/api/chats')).status).toBe(401);
      await claim(friend, 'friend', temporaryPassword);
      expect((await friend.req('GET', '/api/chats')).status).toBe(200);
      // The temporary password is dead; the new one logs in.
      const again = new Browser(g.port);
      expect((await again.req('POST', '/api/auth/login', { username: 'friend', password: temporaryPassword })).status).toBe(401);
      expect((await again.req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(200);
      expect(g.repo.getUserByName('friend')!.last_login_at).not.toBeNull();
      // The admin's own session is untouched.
      expect((await admin.state()).authenticated).toBe(true);
    });
  });

  describe('isolation between accounts', () => {
    it('keeps every account in its own worker with its own database, keys and files', async () => {
      const a = await createUser('alice');
      const b = await createUser('bob');
      const alice = new Browser(g.port);
      const bob = new Browser(g.port);
      await claim(alice, 'alice', a.temporaryPassword, 'purple-monkey-dishwasher-1');
      await claim(bob, 'bob', b.temporaryPassword, 'orange-yeti-teapot-2');
      const w = [1, ...g.repo.listUsers().filter((u) => u.role === 'user').map((u) => u.id)].map((id) => g.pool.workers.get(id)!);
      expect(new Set(w.map((x) => x.dataDir)).size).toBe(3);
      expect(new Set(w.map((x) => x.handle.socketPath)).size).toBe(3);
      expect(new Set(w.map((x) => x.handle.internalToken)).size).toBe(3);
      expect(new Set(w.map((x) => x.ctx.repo.getOwner()?.public_key.toString('hex'))).size).toBe(3);
    });

    it('does not let a session of one user open another user\'s worker, not even with a forged tenant cookie', async () => {
      const a = await createUser('alice');
      const b = await createUser('bob');
      const alice = new Browser(g.port);
      const bob = new Browser(g.port);
      await claim(alice, 'alice', a.temporaryPassword, 'purple-monkey-dishwasher-1');
      await claim(bob, 'bob', b.temporaryPassword, 'orange-yeti-teapot-2');
      const bobId = g.repo.getUserByName('bob')!.id;
      const adminId = 1;
      // Alice presents her own session cookie but points the gateway at Bob's, or the admin's, worker.
      for (const target of [bobId, adminId]) {
        const forged = new Browser(g.port);
        forged.jar = new Map(alice.jar);
        forged.jar.set('wal_tenant', String(target));
        expect((await forged.req('GET', '/api/chats')).status, `chats of ${target}`).toBe(401);
        expect((await forged.req('GET', '/api/auth/sessions')).status).toBe(401);
        expect((await forged.state()).authenticated).toBe(false);
        expect((await forged.req('GET', '/api/admin/overview')).status).toBe(target === adminId ? 401 : 403);
      }
      // Not even by swapping only the session cookie.
      const swapped = new Browser(g.port);
      swapped.jar = new Map(bob.jar);
      swapped.jar.set('wal_session', alice.jar.get('wal_session')!);
      expect((await swapped.req('GET', '/api/chats')).status).toBe(401);
      // A tenant id that does not exist, and junk.
      for (const junk of ['999', '0', '-1', '1e3', 'abc', '1 2']) {
        const bad = new Browser(g.port);
        bad.jar = new Map(alice.jar);
        bad.jar.set('wal_tenant', junk);
        expect((await bad.req('GET', '/api/chats')).status, junk).toBe(401);
      }
      // Alice still works.
      expect((await alice.req('GET', '/api/chats')).status).toBe(200);
    });

    it('does not forward anything under /internal, and /api paths spelled with escapes still need a tenant', async () => {
      const anon = new Browser(g.port);
      for (const p of ['/internal/info', '/%69nternal/info', '/api/../internal/info']) {
        const r = await anon.req('GET', p);
        expect([400, 401, 404], p).toContain(r.status);
        expect(r.body?.hasOwner, p).toBeUndefined();
      }
      expect([400, 401]).toContain((await anon.req('GET', '/%61pi/chats')).status);
      // Odd spellings are refused before they get anywhere near a worker, even for a signed-in user (who would otherwise
      // have the gateway's token attached to whatever path they send).
      for (const p of ['/api/../internal/info', '/api/%2e%2e/internal/info', '/api//internal/info', '/api/..%2finternal/info', '/api/%252e%252e/x', '/api/x\\..\\internal', '/api/./chats', '/api/chats/../../internal/reset']) {
        const r = await admin.req('GET', p);
        expect(r.status, p).toBe(400);
      }
      expect((await admin.req('GET', '/api/chats')).status).toBe(200);
      // A client's own X-WAL-* headers are dropped on the way in.
      const spoof = await admin.req('GET', '/api/auth/whoami', undefined, { headers: { 'x-wal-scope': 'internal', 'x-wal-internal': 'guess' } });
      expect(spoof.status).toBe(200);
      expect((await anon.req('GET', '/api/chats')).status).toBe(401);
      expect((await anon.req('GET', '/api/auth/whoami')).status).toBe(401);
    });

    it('hands the workers the address it worked out itself, whatever the client claims', async () => {
      const a = await createUser('alice');
      const alice = new Browser(g.port);
      await claim(alice, 'alice', a.temporaryPassword, 'purple-monkey-dishwasher-1');
      const w = g.pool.workers.get(g.repo.getUserByName('alice')!.id)!;
      await alice.req('POST', '/api/auth/logout-all', {}, { headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', forwarded: 'for=8.8.8.8', 'x-wal-internal': 'guess' } });
      const rows = w.ctx.repo.listAudit(20);
      const logout = rows.find((r) => r.event === 'logout_all')!;
      expect(logout.ip).toBe('127.0.0.1');
    });

    it('trusts X-Forwarded-For only for the configured number of proxy hops', async () => {
      await g.close();
      g = await makeGateway({ trustProxy: 1 });
      admin = await setupAdmin();
      const c = await createUser('carol');
      const carol = new Browser(g.port);
      await claim(carol, 'carol', c.temporaryPassword, 'green-llama-lantern-3');
      await carol.req('POST', '/api/auth/logout-all', {}, { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });
      const w = g.pool.workers.get(g.repo.getUserByName('carol')!.id)!;
      // One trusted hop: the right-most entry (added by our proxy) is the client; what it sent before is ignored.
      expect(w.ctx.repo.listAudit(20).find((r) => r.event === 'logout_all')!.ip).toBe('203.0.113.9');
    });
  });

  describe('ports', () => {
    it('keeps each user on the port the admin chose and the admin on the default port', async () => {
      expect((await admin.req('POST', '/api/admin/users', { username: 'friend', port: PORT_A })).status).toBe(400); // not opened yet
      expect((await admin.req('PUT', '/api/admin/ports/9999', { origin: null })).status).toBe(400); // not published
      expect((await admin.req('PUT', `/api/admin/ports/${PORT_A}`, { origin: 'javascript:alert(1)' })).status).toBe(400);
      expect((await admin.req('PUT', `/api/admin/ports/${PORT_A}`, { origin: null })).status).toBe(200);
      expect((await admin.req('PUT', `/api/admin/ports/${PORT_A + 1}`, { origin: null })).status).toBe(200);
      const { temporaryPassword } = await createUser('friend', PORT_A);

      // The friend cannot sign in on the default port, nor on the other open port…
      const friend = new Browser(PORT_A);
      for (const port of [g.port, PORT_A + 1]) {
        const wrong = await friend.req('POST', '/api/auth/login', { username: 'friend', password: temporaryPassword }, { port });
        expect(wrong.status, `port ${port}`).toBe(401);
        expect(wrong.body.error.code).toBe('invalid_credentials');
      }
      // …only on their own.
      await claim(friend, 'friend', temporaryPassword, FRIEND_PW, PORT_A);
      expect((await friend.req('GET', '/api/chats', undefined, { port: PORT_A })).status).toBe(200);
      // The session is worthless on every other port.
      expect((await friend.req('GET', '/api/chats', undefined, { port: g.port, origin: `http://127.0.0.1:${g.port}` })).status).toBe(401);
      expect((await friend.req('GET', '/api/chats', undefined, { port: PORT_A + 1, origin: `http://127.0.0.1:${PORT_A + 1}` })).status).toBe(401);

      // The admin cannot sign in on the friend's port; the admin API does not exist there.
      const adminElsewhere = new Browser(PORT_A);
      const r = await adminElsewhere.req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
      expect(r.status).toBe(401);
      const stolen = new Browser(PORT_A);
      stolen.jar = new Map(admin.jar);
      expect((await stolen.req('GET', '/api/admin/overview')).status).toBe(401);
      expect((await stolen.req('GET', '/api/chats')).status).toBe(401);
      // The admin is pinned to the default port even if someone tries to move them.
      expect((await admin.req('PATCH', '/api/admin/users/1', { port: PORT_A })).status).toBe(409);
    });

    it('moves a user to another port, ending their sessions', async () => {
      await admin.req('PUT', `/api/admin/ports/${PORT_A}`, { origin: null });
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      expect((await friend.req('GET', '/api/chats')).status).toBe(200);
      const id = g.repo.getUserByName('friend')!.id;
      expect((await admin.req('PATCH', `/api/admin/users/${id}`, { port: PORT_A })).status).toBe(200);
      expect((await friend.req('GET', '/api/chats')).status).toBe(401);
      const again = new Browser(PORT_A);
      expect((await again.req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(200);
      expect((await new Browser(g.port).req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(401);
    });

    it('only closes a port nobody uses, and really stops listening', async () => {
      await admin.req('PUT', `/api/admin/ports/${PORT_A}`, { origin: 'https://friend.example.com' });
      const { temporaryPassword } = await createUser('friend', PORT_A);
      void temporaryPassword;
      const busy = await admin.req('DELETE', `/api/admin/ports/${PORT_A}`);
      expect(busy.status).toBe(409);
      expect(busy.body.error.message).toContain('friend');
      const id = g.repo.getUserByName('friend')!.id;
      await admin.req('PATCH', `/api/admin/users/${id}`, { port: null });
      expect((await admin.req('DELETE', `/api/admin/ports/${PORT_A}`)).status).toBe(200);
      await expect(new Promise((res, rej) => net.connect(PORT_A, '127.0.0.1').once('connect', res).once('error', rej))).rejects.toThrow();
      expect((await admin.req('DELETE', `/api/admin/ports/${PORT_A}`)).status).toBe(404);
    });

    it('checks the Origin per port: the configured one for an extra port, the admin\'s own for the default', async () => {
      await g.close();
      g = await makeGateway({ extraPorts: [PORT_A], publicOrigin: undefined });
      admin = await setupAdmin();
      await admin.req('PUT', `/api/admin/ports/${PORT_A}`, { origin: 'https://friend.example.com' });
      const { temporaryPassword } = await createUser('friend', PORT_A);
      const f = new Browser(PORT_A);
      // The friend's domain is reached through the reverse proxy: only that origin is accepted on that port.
      const bad = await f.req('POST', '/api/auth/login', { username: 'friend', password: temporaryPassword }, { origin: 'https://wa.admin.example.com' });
      expect(bad.status).toBe(403);
      const ok = await f.req('POST', '/api/auth/login', { username: 'friend', password: temporaryPassword }, { origin: 'https://friend.example.com' });
      expect(ok.status).toBe(200);
    });
  });

  describe('account control by the admin', () => {
    it('disables and re-enables a user, ending their sessions', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      const id = g.repo.getUserByName('friend')!.id;
      expect((await admin.req('PATCH', `/api/admin/users/${id}`, { disabled: true })).status).toBe(200);
      expect((await friend.req('GET', '/api/chats')).status).toBe(401);
      expect((await new Browser(g.port).req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(401);
      expect((await admin.req('PATCH', `/api/admin/users/${id}`, { disabled: false })).status).toBe(200);
      expect((await new Browser(g.port).req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(200);
      expect((await admin.req('PATCH', '/api/admin/users/1', { disabled: true })).status).toBe(409);
    });

    it('resets a password with the recovery key, after the admin proves their password', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      const id = g.repo.getUserByName('friend')!.id;
      const noPw = await admin.req('POST', `/api/admin/users/${id}/reset`, { mode: 'recovery', adminPassword: 'wrong-wrong-wrong-xx' });
      expect(noPw.status).toBe(401);
      expect((await friend.req('GET', '/api/chats')).status).toBe(200); // nothing happened
      const r = await admin.req('POST', `/api/admin/users/${id}/reset`, { mode: 'recovery', adminPassword: ADMIN_PW });
      expect(r.status).toBe(200);
      const reset = r.body as ResetUserResponse;
      expect(reset.mode).toBe('recovery');
      expect((await friend.req('GET', '/api/chats')).status).toBe(401);
      const f2 = new Browser(g.port);
      // The old password is dead; the new temporary one asks for the recovery key.
      expect((await f2.req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(401);
      const l = await f2.req('POST', '/api/auth/login', { username: 'friend', password: reset.temporaryPassword });
      expect(l.body).toEqual({ ok: false, mustChangePassword: true, needRecoveryKey: true });
      const noKey = await f2.req('POST', '/api/auth/claim', { username: 'friend', password: reset.temporaryPassword, newPassword: 'a-brand-new-passphrase-1' });
      expect(noKey.status).toBe(401);
      expect((await admin.req('GET', '/api/admin/overview')).body.users.find((u: { id: number }) => u.id === id).status).toBe('reset');
    });

    it('wipes an account: data, keys and the linked browser profile', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      const id = g.repo.getUserByName('friend')!.id;
      const oldKey = Buffer.from(g.pool.workers.get(id)!.ctx.repo.getOwner()!.public_key);
      const r = await admin.req('POST', `/api/admin/users/${id}/reset`, { mode: 'wipe', adminPassword: ADMIN_PW });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(g.pool.browserResets).toEqual([id]);
      const f2 = new Browser(g.port);
      const l = await f2.req('POST', '/api/auth/login', { username: 'friend', password: r.body.temporaryPassword });
      expect(l.body).toEqual({ ok: false, mustChangePassword: true, needRecoveryKey: false });
      await claim(f2, 'friend', r.body.temporaryPassword, 'brand-new-passphrase-77');
      const fresh = g.pool.workers.get(id)!.ctx.repo.getOwner()!;
      expect(fresh.public_key.equals(oldKey)).toBe(false);
    });

    it('re-issues a temporary password for an account nobody has claimed yet', async () => {
      const { temporaryPassword } = await createUser('friend');
      const id = g.repo.getUserByName('friend')!.id;
      const r = await admin.req('POST', `/api/admin/users/${id}/reset`, { mode: 'wipe', adminPassword: ADMIN_PW });
      expect(r.body.mode).toBe('new');
      const f = new Browser(g.port);
      expect((await f.req('POST', '/api/auth/login', { username: 'friend', password: temporaryPassword })).status).toBe(401);
      await claim(f, 'friend', r.body.temporaryPassword);
    });

    it('deletes a user with everything they own, and never the admin', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      const id = g.repo.getUserByName('friend')!.id;
      expect((await admin.req('POST', `/api/admin/users/${id}/delete`, { adminPassword: 'wrong-wrong-wrong-xx' })).status).toBe(401);
      expect(g.repo.getUser(id)).toBeDefined();
      expect((await admin.req('POST', `/api/admin/users/${id}/delete`, { adminPassword: ADMIN_PW })).status).toBe(200);
      expect(g.pool.removed).toContain(id);
      expect(g.repo.getUser(id)).toBeUndefined();
      expect((await friend.req('GET', '/api/chats')).status).toBe(401);
      expect((await new Browser(g.port).req('POST', '/api/auth/login', { username: 'friend', password: FRIEND_PW })).status).toBe(401);
      expect((await admin.req('POST', '/api/admin/users/1/delete', { adminPassword: ADMIN_PW })).status).toBe(409);
      // A deleted name can be used again, but it is a new account with a new id (and a new unix user).
      const again = await createUser('friend');
      expect(g.repo.getUserByName('friend')!.id).toBeGreaterThan(id);
      expect(again.user.status).toBe('pending');
    });

    it('keeps a block list per user: only the admin sets it, it replaces the old one, the log has no numbers', async () => {
      const { temporaryPassword } = await createUser('friend');
      const friend = new Browser(g.port);
      await claim(friend, 'friend', temporaryPassword);
      const id = g.repo.getUserByName('friend')!.id;
      const url = `/api/admin/users/${id}/blocking`;
      expect((await friend.req('GET', url)).status).toBeGreaterThanOrEqual(401);
      expect((await friend.req('PUT', url, { phones: ['905559990001'] })).status).toBeGreaterThanOrEqual(401);
      expect((await admin.req('PUT', url, { phones: ['not a number'] })).status).toBe(400);
      expect((await admin.req('PUT', url, { phones: ['+90 555 999 00 01'] })).body).toEqual({ ok: true, count: 1 });
      expect((await admin.req('GET', url)).body).toEqual({ contacts: [{ phone: '905559990001', label: null, blocked: true }] });
      expect((await admin.req('PUT', url, { phones: [] })).body).toEqual({ ok: true, count: 0 });
      expect((await admin.req('GET', url)).body).toEqual({ contacts: [] });
      expect((await admin.req('GET', '/api/admin/users/1/blocking')).status).toBe(409);
      const log = (await admin.req('GET', '/api/admin/audit')).body as { event: string; detail: string | null }[];
      expect(log.find((e) => e.event === 'user_blocklist_changed')).toBeDefined();
      expect(JSON.stringify(log)).not.toContain('5559990001');
    });

    it('records what the admin did, without secrets', async () => {
      const made = await createUser('friend');
      const log = (await admin.req('GET', '/api/admin/audit')).body as { event: string; actor: string | null; target: string | null; detail: string | null }[];
      expect(log.map((e) => e.event)).toEqual(expect.arrayContaining(['signup', 'user_created']));
      expect(log.find((e) => e.event === 'user_created')).toMatchObject({ actor: 'admin', target: 'friend' });
      expect(JSON.stringify(log)).not.toContain(made.temporaryPassword);
    });
  });

  describe('streams', () => {
    it('forwards live updates (SSE) for the signed-in user only', async () => {
      const get = (headers: Record<string, string>) =>
        new Promise<{ status: number; seen: string; req: http.ClientRequest }>((resolve) => {
          const req = http.get({ host: '127.0.0.1', port: g.port, path: '/api/events', headers }, (res) => {
            let seen = '';
            if (res.statusCode !== 200) return resolve({ status: res.statusCode ?? 0, seen, req });
            res.on('data', (d: Buffer) => {
              seen += d.toString();
              if (seen.includes('event: wa_state')) resolve({ status: 200, seen, req });
            });
          });
          setTimeout(() => resolve({ status: -1, seen: '', req }), 5000).unref();
        });
      expect((await get({})).status).toBe(401);
      const ok = await get({ cookie: admin.cookieHeader() });
      ok.req.destroy();
      expect(ok.status).toBe(200);
      expect(ok.seen).toMatch(/event: wa_state/);
    });

    it('tunnels WebSocket upgrades only for a valid session from the right origin', async () => {
      const attempt = (headers: Record<string, string>) =>
        new Promise<{ ok: boolean; status?: number; ws?: WebSocket }>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/vnc`, { headers });
          ws.on('unexpected-response', (_r, res) => resolve({ ok: false, status: res.statusCode }));
          ws.on('open', () => resolve({ ok: true, ws }));
          ws.on('error', () => resolve({ ok: false }));
        });
      const origin = `http://127.0.0.1:${g.port}`;
      expect((await attempt({ origin })).status).toBe(401);
      expect((await attempt({ origin: 'http://evil.test', cookie: admin.cookieHeader() })).status).toBe(403);
      const forged = new Map(admin.jar);
      forged.set('wal_tenant', '999');
      expect((await attempt({ origin, cookie: [...forged].map(([k, v]) => `${k}=${v}`).join('; ') })).status).toBe(401);
      const good = await attempt({ origin, cookie: admin.cookieHeader() });
      expect(good.ok).toBe(true); // upgraded through the gateway to the worker (which closes it: no Chromium in this test)
      good.ws!.on('error', () => undefined);
      good.ws!.terminate();
    });
  });

  describe('hardening', () => {
    it('answers the same hardening headers as a single-user instance and no server banner', async () => {
      const r = await new Browser(g.port).req('GET', '/api/state');
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-powered-by']).toBeUndefined();
    });

    it('rejects cross-origin state changes on the sign-in routes', async () => {
      const { temporaryPassword } = await createUser('friend');
      for (const p of ['/api/auth/login', '/api/auth/claim', '/api/auth/recover', '/api/auth/signup']) {
        const r = await new Browser(g.port).req('POST', p, { username: 'friend', password: temporaryPassword, newPassword: 'x', setupToken: SETUP }, { origin: 'http://evil.test' });
        expect(r.status, p).toBe(403);
      }
      const noOrigin = await new Browser(g.port).req('POST', '/api/auth/login', { username: 'friend', password: temporaryPassword }, { origin: null });
      expect(noOrigin.status).toBe(403);
    });

    it('rate-limits password guesses per IP before they cost scrypt, for known and unknown names alike', async () => {
      const b = new Browser(g.port);
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await b.req('POST', '/api/auth/login', { username: 'nobody', password: `guess-${i}-xxxxxxxx` })).status;
      expect(last).toBe(429);
      const known = new Browser(g.port);
      let lastKnown = 0;
      for (let i = 0; i < 12; i++) lastKnown = (await known.req('POST', '/api/auth/login', { username: 'admin', password: `guess-${i}-xxxxxxxx` })).status;
      expect(lastKnown).toBe(429);
    });
  });
});

describe('gateway helpers', () => {
  const req = (remote: string, headers: Record<string, string>) => ({ socket: { remoteAddress: remote }, headers }) as never;

  it('takes the client address like Fastify\'s trustProxy hop count (WebSocket upgrades use this)', () => {
    const h = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.5', 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'wa.example.com', host: 'internal' };
    // No trusted proxy: the socket peer, headers ignored.
    expect(rawClientInfo(req('172.18.0.2', h), 0)).toEqual({ ip: '172.18.0.2', proto: 'http', host: 'internal' });
    // One hop (Caddy): the last X-Forwarded-For entry.
    expect(rawClientInfo(req('172.18.0.2', h), 1)).toMatchObject({ ip: '10.0.0.5', proto: 'https', host: 'wa.example.com' });
    // Two hops (Caddy + NPM): the one before it; the first entry a client could have forged is never used.
    expect(rawClientInfo(req('::ffff:172.18.0.2', h), 2).ip).toBe('203.0.113.9');
    expect(rawClientInfo(req('172.18.0.2', h), 5).ip).toBe('6.6.6.6');
    expect(rawClientInfo(req('172.18.0.2', {}), 2).ip).toBe('172.18.0.2');
  });

  it('forwards only plain /api paths', () => {
    for (const ok of ['/api', '/api/state', '/api/chats/123@c.us/messages?limit=60&before=x', '/api/media/12', '/api/messages/false_9055@c.us_ABC/edits']) expect(cleanApiPath(ok), ok).toBe(true);
    for (const bad of ['/apix', '/api/../internal/info', '/api/%2e%2e/x', '/api//x', '/api/%2fx', '/api/x%00', '/api/\\x', '/internal/info', '/%61pi/x', '/api/%252e', '/api/x y']) expect(cleanApiPath(bad), bad).toBe(false);
  });
});
