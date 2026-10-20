import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataReader, PRIVKEY_AAD, unwrapPrivateKey } from '../crypto/keyring.js';
import { derivePasswordKeys } from '../crypto/password.js';
import { F } from '../db/repo.js';
import { PASSWORD, makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { Ingest, type WaApi } from '../wa/ingest.js';

/*
 * The tenant-worker side of multi-user support: the gateway's /internal routes, the temporary-password claim flow
 * and the admin reset. (The gateway itself is covered in gateway/gateway.test.ts.)
 */

const INTERNAL_TOKEN = 'internal-token-0123456789-abcdefghij';
const TEMP = 'Temp-Password-Issued-By-Admin';
const NEW_PASSWORD = 'my-very-own-passphrase-123';
const CHAT = '905551112233@c.us';

const api: WaApi = {
  getChat: async () => ({ name: 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
};

describe('multi-user worker', () => {
  let h: Harness;
  let gw: TestClient;
  // What a browser's request looks like once the gateway has forwarded it (it adds the token).
  let browser: () => TestClient;
  const internal = (method: string, url: string, body?: unknown) =>
    gw.req(method, url, body, { origin: null, headers: { 'x-wal-internal': INTERNAL_TOKEN } });

  beforeEach(async () => {
    // A worker as the supervisor starts it: no setup token, an internal token.
    h = await makeHarness({ SETUP_TOKEN: '', INTERNAL_TOKEN });
    gw = h.client();
    browser = () => h.client({ 'x-wal-internal': INTERNAL_TOKEN });
  });
  afterEach(async () => {
    await h.close();
  });

  it('refuses every request that lacks the gateway token', async () => {
    const c = h.client();
    expect((await c.req('GET', '/internal/info', undefined, { origin: null })).status).toBe(403);
    expect((await c.req('GET', '/api/state', undefined, { origin: null })).status).toBe(403);
    expect((await c.req('GET', '/healthz', undefined, { origin: null, headers: { 'x-wal-internal': 'wrong' } })).status).toBe(403);
    expect((await internal('GET', '/internal/info')).status).toBe(200);
  });

  it('has no public signup route without a setup token, and no /internal routes without an internal token', async () => {
    const plain = await makeHarness({ SETUP_TOKEN: '' });
    try {
      expect(plain.ctx.routeTable.some((r) => r.url === '/api/auth/signup')).toBe(false);
      expect(plain.ctx.routeTable.some((r) => r.url.startsWith('/internal/'))).toBe(false);
    } finally {
      await plain.close();
    }
    expect(h.ctx.routeTable.some((r) => r.url === '/api/auth/signup')).toBe(false);
  });

  it('creates the admin account through /internal/signup once', async () => {
    const r = await internal('POST', '/internal/signup', { username: 'admin', password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.recoveryKey).toMatch(/^[A-Z0-9-]+$/);
    expect(h.ctx.repo.getOwner()?.username).toBe('admin');
    expect((await internal('POST', '/internal/signup', { username: 'other', password: PASSWORD })).status).toBe(409);
    expect((await internal('POST', '/internal/signup', { username: 'x', password: 'short' })).status).toBe(400);
  });

  describe('a provisioned account', () => {
    beforeEach(async () => {
      expect((await internal('POST', '/internal/provision', { username: 'friend', tempPassword: TEMP })).status).toBe(200);
    });

    it('has no keys and no session until the user chooses a password', async () => {
      expect(h.ctx.repo.getOwner()).toBeUndefined();
      expect(h.ctx.writer()).toBeNull();
      const c = browser();
      expect((await internal('GET', '/internal/info')).body).toMatchObject({ hasOwner: false, username: 'friend', pending: 'new' });
      const bad = await c.req('POST', '/api/auth/login', { username: 'friend', password: 'not-the-password' });
      expect(bad.status).toBe(401);
      const wrongUser = await c.req('POST', '/api/auth/login', { username: 'someone', password: TEMP });
      expect(wrongUser.status).toBe(401);
      const ok = await c.req('POST', '/api/auth/login', { username: 'Friend', password: TEMP });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: false, mustChangePassword: true, needRecoveryKey: false });
      expect(ok.headers['set-cookie']).toBeUndefined();
      // Without a session nothing is reachable.
      expect((await c.req('GET', '/api/chats')).status).toBe(401);
    });

    it('claims the account: new password, new keys, recovery key, session', async () => {
      const c = browser();
      expect((await c.req('POST', '/api/auth/claim', { username: 'friend', password: 'wrong', newPassword: NEW_PASSWORD })).status).toBe(401);
      expect((await c.req('POST', '/api/auth/claim', { username: 'friend', password: TEMP, newPassword: 'short' })).status).toBe(400);
      expect((await c.req('POST', '/api/auth/claim', { username: 'friend', password: TEMP, newPassword: TEMP })).status).toBe(400);
      const r = await c.req('POST', '/api/auth/claim', { username: 'friend', password: TEMP, newPassword: NEW_PASSWORD });
      expect(r.status).toBe(200);
      expect(r.body.recoveryKey).toBeTruthy();
      await c.refreshState();
      expect((await c.req('GET', '/api/chats')).status).toBe(200);

      const owner = h.ctx.repo.getOwner()!;
      expect(owner.username).toBe('friend');
      // The temporary password (which the admin knew) never wrapped this account's private key.
      const tmp = await derivePasswordKeys(TEMP, owner.pw_salt, h.ctx.config.scryptLogN);
      expect(() => unwrapPrivateKey(tmp.kek, owner.privkey_pw, PRIVKEY_AAD.password)).toThrow();
      const mine = await derivePasswordKeys(NEW_PASSWORD, owner.pw_salt, h.ctx.config.scryptLogN);
      expect(() => unwrapPrivateKey(mine.kek, owner.privkey_pw, PRIVKEY_AAD.password)).not.toThrow();
      expect(h.ctx.repo.getPendingClaim()).toBeUndefined();

      // The temporary password is dead now, the new one works.
      const c2 = browser();
      expect((await c2.login('friend', TEMP)).status).toBe(401);
      expect((await c2.login('friend', NEW_PASSWORD)).status).toBe(200);
      // A second claim has nothing to claim.
      expect((await browser().req('POST', '/api/auth/claim', { username: 'friend', password: TEMP, newPassword: NEW_PASSWORD })).status).toBe(401);
    });

    it('throttles guesses of the temporary password per IP', async () => {
      const c = browser();
      let last = 0;
      for (let i = 0; i < 8; i++) last = (await c.req('POST', '/api/auth/login', { username: 'friend', password: `guess-${i}-xxxxxxxx` })).status;
      expect(last).toBe(429);
      // Also while locked, the right password is refused.
      expect((await c.req('POST', '/api/auth/login', { username: 'friend', password: TEMP })).status).toBe(429);
    });

    it('cannot be provisioned again once claimed', async () => {
      await browser().req('POST', '/api/auth/claim', { username: 'friend', password: TEMP, newPassword: NEW_PASSWORD });
      expect((await internal('POST', '/internal/provision', { username: 'friend', tempPassword: 'Another-Temp-Pass-1' })).status).toBe(409);
    });
  });

  describe('admin reset of a claimed account', () => {
    let ingest: Ingest;
    let c: TestClient;
    let recoveryKey: string;
    const FIRST = 'hello before the reset';

    beforeEach(async () => {
      await internal('POST', '/internal/provision', { username: 'friend', tempPassword: TEMP });
      c = browser();
      recoveryKey = (await c.req('POST', '/api/auth/claim', { username: 'friend', password: TEMP, newPassword: NEW_PASSWORD })).body.recoveryKey;
      await c.refreshState();
      ingest = new Ingest(h.ctx, api, { enqueue: () => undefined });
      await ingest.message({ id: { fromMe: false, remote: CHAT, id: 'M1', _serialized: `false_${CHAT}_M1` }, type: 'chat', body: FIRST, t: 1_700_000_001, from: CHAT, ack: 1 }, 'live');
    });

    it('recovery mode: kills sessions and the old password, the user comes back with the recovery key and keeps the data', async () => {
      expect((await internal('POST', '/internal/reset', { mode: 'recovery', tempPassword: 'Second-Temp-Password-9' })).status).toBe(200);
      expect((await c.req('GET', '/api/chats')).status).toBe(401);
      const d = browser();
      // The old password no longer opens the account.
      expect((await d.req('POST', '/api/auth/login', { username: 'friend', password: NEW_PASSWORD })).status).toBe(401);
      const tmp = await d.req('POST', '/api/auth/login', { username: 'friend', password: 'Second-Temp-Password-9' });
      expect(tmp.body).toEqual({ ok: false, mustChangePassword: true, needRecoveryKey: true });
      const claim = (extra: object) =>
        d.req('POST', '/api/auth/claim', { username: 'friend', password: 'Second-Temp-Password-9', newPassword: 'brand-new-passphrase-456', ...extra });
      expect((await claim({})).status).toBe(401);
      expect((await claim({ recoveryKey: 'AAAA-BBBB' })).status).toBe(401);
      const ok = await claim({ recoveryKey });
      expect(ok.status).toBe(200);
      expect(ok.body.recoveryKey).not.toBe(recoveryKey);
      await d.refreshState();
      const chats = await d.req('GET', '/api/chats');
      expect(chats.status).toBe(200);
      const owner = h.ctx.repo.getOwner()!;
      const { kek } = await derivePasswordKeys('brand-new-passphrase-456', owner.pw_salt, h.ctx.config.scryptLogN);
      const reader = DataReader.fromPkcs8(h.ctx.repo, unwrapPrivateKey(kek, owner.privkey_pw, PRIVKEY_AAD.password));
      expect(reader.tryText(...F.body('false_' + CHAT + '_M1'), h.ctx.repo.getMessage('false_' + CHAT + '_M1')?.body_enc)).toBe(FIRST);
      expect(h.ctx.repo.getPendingClaim()).toBeUndefined();
    });

    it('wipe mode: deletes the data and the keys, the next claim starts from scratch', async () => {
      const oldKey = Buffer.from(h.ctx.repo.getOwner()!.public_key);
      expect((await internal('POST', '/internal/reset', { mode: 'wipe', tempPassword: 'Second-Temp-Password-9' })).status).toBe(200);
      expect(h.ctx.repo.hasOwner()).toBe(false);
      expect(h.ctx.repo.getMessage('false_' + CHAT + '_M1')).toBeUndefined();
      expect(h.ctx.writer()).toBeNull();
      expect((await c.req('GET', '/api/chats')).status).toBe(401);
      const d = browser();
      expect((await d.req('POST', '/api/auth/login', { username: 'friend', password: 'Second-Temp-Password-9' })).body).toEqual({
        ok: false,
        mustChangePassword: true,
        needRecoveryKey: false,
      });
      // The old recovery key opens nothing any more.
      expect((await d.req('POST', '/api/auth/claim', { username: 'friend', password: 'Second-Temp-Password-9', newPassword: 'another-passphrase-789', recoveryKey })).status).toBe(200);
      const fresh = h.ctx.repo.getOwner()!;
      expect(fresh.public_key.equals(oldKey)).toBe(false);
      expect(h.ctx.writer()).not.toBeNull();
      expect(h.ctx.repo.getOwner()!.recovery_auth_hash.length).toBeGreaterThan(0);
    });

    it('revokes all sessions on request', async () => {
      const r = await internal('POST', '/internal/revoke-sessions');
      expect(r.body).toEqual({ ok: true, sessions: 1 });
      expect((await c.req('GET', '/api/chats')).status).toBe(401);
    });
  });

  it('verifies the password for destructive admin actions', async () => {
    const c = browser();
    await internal('POST', '/internal/signup', { username: 'admin', password: PASSWORD });
    expect((await c.login('admin', PASSWORD)).status).toBe(200);
    expect((await c.req('POST', '/api/auth/verify', { password: 'nope-nope-nope-nope' })).status).toBe(401);
    expect((await c.req('POST', '/api/auth/verify', { password: PASSWORD })).status).toBe(200);
    expect((await c.req('POST', '/api/auth/ping', {})).status).toBe(200);
    expect((await c.req('POST', '/api/auth/ping', {}, { csrf: null })).status).toBe(403);
    expect((await browser().req('GET', '/api/auth/whoami')).status).toBe(401);
  });
});
