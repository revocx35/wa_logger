import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullWa, type WaController, type WaSender } from '../context.js';
import { ORIGIN, makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import type { RawMsg } from '../wa/mapper.js';

const GROUP = '120363000000000001@g.us';
const DM = '905551112233@c.us';
const OTHER = '905559998877@c.us';
const msg = (id: string, remote: string, body: string): RawMsg => ({
  id: { fromMe: false, remote, id, _serialized: `false_${remote}_${id}` },
  type: 'chat',
  body,
  t: 1_700_000_000,
  from: remote,
  ack: 1,
});
const waApi: WaApi = {
  getChat: async (id: string) => ({ name: id === GROUP ? 'Poker Night' : 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
} as WaApi;

class FakeWa extends NullWa {
  sent: unknown[][] = [];
  override readonly sender: WaSender = {
    ...new NullWa().sender,
    sendText: (async (...a: unknown[]) => {
      this.sent.push(a);
      return { id: 'true_X_SENT' };
    }) as WaSender['sendText'],
  };
}

describe('API tokens', () => {
  let h: Harness;
  let c: TestClient;
  let wa: FakeWa;
  const bearer = (token: string | null, extra: Record<string, string> = {}) => ({
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'content-type': 'application/json',
    ...extra,
  });
  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown) =>
    h.app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  const create = async (chatIds = [GROUP]) => {
    const r = await c.req('POST', '/api/api-tokens', { name: 'Poker', chatIds });
    expect(r.status).toBe(200);
    return r.body.token as string;
  };

  beforeEach(async () => {
    wa = new FakeWa();
    h = await makeHarness({}, { wa: () => wa as WaController });
    c = h.client();
    await c.signup();
    const ingest = new Ingest(h.ctx, waApi, { enqueue: () => undefined });
    await ingest.message(msg('M1', GROUP, 'hello'), 'live');
    await ingest.message(msg('M2', DM, 'hi'), 'live');
    await ingest.message(msg('M3', OTHER, 'secret'), 'live');
  });
  afterEach(async () => {
    await h.close();
  });

  it('creates a token once, lists chat names with it, and sends only to the chosen chats', async () => {
    const token = await create([GROUP, DM]);
    expect(token).toMatch(/^walt_1_[A-Za-z0-9_-]{43}$/);
    const list = await c.req('GET', '/api/api-tokens');
    expect(list.body.tokens).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token.slice(10));

    const d = await call('GET', '/api/v1/destinations', bearer(token));
    expect(d.statusCode).toBe(200);
    expect(JSON.parse(d.body).destinations).toEqual([
      { chatId: GROUP, kind: 'group', name: 'Poker Night' },
      { chatId: DM, kind: 'user', name: 'Ali Veli' },
    ]);

    const ok = await call('POST', '/api/v1/send', bearer(token), { chatId: GROUP, text: 'Game 1 results' });
    expect(ok.statusCode).toBe(200);
    expect(wa.sent).toEqual([[GROUP, 'Game 1 results', null]]);

    // A chat the token was not made for looks exactly like a chat that does not exist.
    const no = await call('POST', '/api/v1/send', bearer(token), { chatId: OTHER, text: 'nope' });
    const none = await call('POST', '/api/v1/send', bearer(token), { chatId: '123456789@c.us', text: 'nope' });
    expect(no.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);
    expect(no.body).toBe(none.body);
    expect(wa.sent).toHaveLength(1);
    expect((await c.req('GET', '/api/api-tokens')).body.tokens[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('stores only a hash of the token and seals the chat names', async () => {
    const token = await create();
    h.ctx.repo.db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = fs.readFileSync(h.ctx.config.dbPath);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from('Poker Night'))).toBe(false);
    expect(fs.statSync(path.join(h.ctx.config.dataDir, 'apitoken.key')).mode & 0o077).toBe(0);
  });

  it('refuses missing, malformed, wrong and revoked tokens', async () => {
    const token = await create();
    for (const t of [null, 'walt_1_' + 'A'.repeat(43), 'garbage', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')]) {
      expect((await call('GET', '/api/v1/destinations', bearer(t))).statusCode, String(t)).toBe(401);
    }
    expect((await call('GET', '/api/v1/destinations', { authorization: `Basic ${token}` })).statusCode).toBe(401);
    expect((await call('GET', `/api/v1/destinations?token=${token}`, {})).statusCode).toBe(401);
    const id = (await c.req('GET', '/api/api-tokens')).body.tokens[0].id;
    expect((await c.req('DELETE', `/api/api-tokens/${id}`)).status).toBe(200);
    expect((await call('GET', '/api/v1/destinations', bearer(token))).statusCode).toBe(401);
    expect(wa.sent).toEqual([]);
  });

  it('ignores cookies on token routes and tokens on session routes', async () => {
    const token = await create();
    const viaCookie = await call('GET', '/api/v1/destinations', { cookie: c.cookie, origin: ORIGIN });
    expect(viaCookie.statusCode).toBe(401);
    const sessionRoute = await call('GET', '/api/chats', bearer(token));
    expect(sessionRoute.statusCode).toBe(401);
    const send = await call('POST', `/api/chats/${GROUP}/send`, bearer(token, { origin: ORIGIN }), { text: 'x' });
    expect(send.statusCode).toBe(401);
    // Creating or deleting tokens needs a real session with CSRF + origin; a token can't mint more tokens.
    expect((await call('POST', '/api/api-tokens', bearer(token), { name: 'x', chatIds: [GROUP] })).statusCode).toBe(403);
    expect((await call('POST', '/api/api-tokens', bearer(token, { origin: ORIGIN }), { name: 'x', chatIds: [GROUP] })).statusCode).toBe(401);
    expect((await c.req('POST', '/api/api-tokens', { name: 'x', chatIds: [GROUP] }, { csrf: null })).status).toBe(403);
    expect((await h.client().req('GET', '/api/api-tokens')).status).toBe(401);
    expect(wa.sent).toEqual([]);
  });

  it('validates input', async () => {
    const token = await create();
    const post = (b: unknown) => call('POST', '/api/v1/send', bearer(token), b);
    expect((await post({ chatId: GROUP, text: '  ' })).statusCode).toBe(400);
    expect((await post({ chatId: GROUP, text: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await post({ chatId: GROUP, text: 'hi', extra: 1 })).statusCode).toBe(400);
    expect((await post({ chatId: '../x', text: 'hi' })).statusCode).toBe(400);
    expect((await c.req('POST', '/api/api-tokens', { name: 'x', chatIds: [] })).status).toBe(400);
    expect((await c.req('POST', '/api/api-tokens', { name: 'x', chatIds: ['999999@c.us'] })).status).toBe(404);
    expect(wa.sent).toEqual([]);
  });
});
