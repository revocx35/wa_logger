import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSummary, DeletedFeedPage, MessagePage, SearchResponse } from '../../../shared/api.js';
import { ORIGIN, PASSWORD, makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import { beginMediaFile, finishMediaFile } from '../wa/media.js';
import type { RawMsg } from '../wa/mapper.js';
import { inlineContentType, safeFilename } from './media.js';

const CHAT = '905551112233@c.us';
const OTHER = '905559998877@c.us';

function rid(msgId: string, remote = CHAT, fromMe = false) {
  return { fromMe, remote, id: msgId, _serialized: `${fromMe}_${remote}_${msgId}` };
}
const text = (msgId: string, body: string, t: number, over: RawMsg = {}): RawMsg => ({
  id: rid(msgId),
  type: 'chat',
  body,
  t,
  from: CHAT,
  ack: 1,
  ...over,
});

const api: WaApi = {
  getChat: async (id) => ({ name: id === CHAT ? 'Ali Veli' : 'Other Person', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
};

async function seedMedia(h: Harness, data: Buffer, mime: string, filename: string | null): Promise<number> {
  const f = await beginMediaFile(h.ctx);
  await f.writer.write(data);
  return (await finishMediaFile(h.ctx, f, 'message', mime, filename)).mediaId;
}

describe('api', () => {
  let h: Harness;
  let c: TestClient;
  let ingest: Ingest;

  beforeEach(async () => {
    h = await makeHarness();
    c = h.client();
    await c.signup();
    ingest = new Ingest(h.ctx, api, { enqueue: () => undefined });
    for (let i = 1; i <= 75; i++) await ingest.message(text(`M${i}`, `message number ${i}`, 1_700_000_000 + i), 'live');
    await ingest.message({ ...text('Q1', 'this is a reply', 1_700_000_100), quotedMsg: { type: 'chat', body: 'message number 3' }, quotedStanzaID: 'M3', quotedParticipant: CHAT }, 'live');
    await ingest.message({ id: rid('O1', OTHER), type: 'chat', body: 'hello from the other chat about pineapples', t: 1_700_000_200, from: OTHER }, 'live');
    await ingest.revoke({ ...text('M10', '', 1_700_000_010), type: 'revoked', subtype: 'sender' }, null);
    await ingest.edit(text('M20', 'edited twenty', 1_700_000_020, { latestEditMsgKey: { _serialized: 'EK' } }), 'edited twenty', 'message number 20');
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists chats with decrypted names, counts and previews', async () => {
    const r = await c.req('GET', '/api/chats');
    expect(r.status).toBe(200);
    const chats = r.body as ChatSummary[];
    expect(chats.map((x) => x.name)).toEqual(['Other Person', 'Ali Veli']);
    const ali = chats.find((x) => x.id === CHAT)!;
    expect(ali.messageCount).toBe(76);
    expect(ali.deletedCount).toBe(1);
    expect(ali.lastMessage?.text).toBe('this is a reply');
    expect(ali.kind).toBe('user');
  });

  it('pages messages newest-first with cursors', async () => {
    const p1 = (await c.req('GET', `/api/chats/${CHAT}/messages?limit=30`)).body as MessagePage;
    expect(p1.messages).toHaveLength(30);
    expect(p1.messages.at(-1)!.text).toBe('this is a reply');
    expect(p1.nextBefore).toBeTruthy();
    const p2 = (await c.req('GET', `/api/chats/${CHAT}/messages?limit=30&before=${p1.nextBefore}`)).body as MessagePage;
    expect(p2.messages.at(-1)!.ts).toBeLessThan(p1.messages[0]!.ts);
    const p3 = (await c.req('GET', `/api/chats/${CHAT}/messages?limit=30&before=${p2.nextBefore}`)).body as MessagePage;
    expect(p3.messages).toHaveLength(16);
    expect(p3.nextBefore).toBeNull();
    const all = [...p3.messages, ...p2.messages, ...p1.messages];
    expect(new Set(all.map((m) => m.id)).size).toBe(76);
  });

  it('exposes deleted, edited and quoted state on messages', async () => {
    const around = (await c.req('GET', `/api/chats/${CHAT}/messages/around/${encodeURIComponent(`false_${CHAT}_M10`)}?limit=10`)).body as MessagePage;
    const del = around.messages.find((m) => m.id === `false_${CHAT}_M10`)!;
    expect(del.deletedAt).toBeGreaterThan(0);
    expect(del.text).toBe('message number 10');
    expect(around.nextBefore).toBeTruthy();
    expect(around.nextAfter).toBeTruthy();

    const edited = (await c.req('GET', `/api/messages/${encodeURIComponent(`false_${CHAT}_M20`)}`)).body;
    expect(edited.text).toBe('edited twenty');
    expect(edited.edited).toBe(true);
    expect(edited.editCount).toBe(1);
    const edits = (await c.req('GET', `/api/messages/${encodeURIComponent(`false_${CHAT}_M20`)}/edits`)).body;
    expect(edits).toEqual([{ body: 'message number 20', capturedAt: expect.any(Number) }]);

    const reply = (await c.req('GET', `/api/messages/${encodeURIComponent(`false_${CHAT}_Q1`)}`)).body;
    expect(reply.quoted).toMatchObject({ id: `false_${CHAT}_M3`, text: 'message number 3', senderName: 'Ali Veli' });
  });

  it('serves the deleted-messages feed', async () => {
    const r = (await c.req('GET', '/api/deleted')).body as DeletedFeedPage;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.chat.name).toBe('Ali Veli');
    expect(r.items[0]!.message.text).toBe('message number 10');
  });

  it('searches decrypted content, optionally within a chat', async () => {
    let r = (await c.req('GET', '/api/search?q=PINEAPPLE')).body as SearchResponse;
    expect(r.hits.map((x) => x.message.id)).toEqual([`false_${OTHER}_O1`]);
    r = (await c.req('GET', `/api/search?q=pineapple&chatId=${CHAT}`)).body as SearchResponse;
    expect(r.hits).toHaveLength(0);
    r = (await c.req('GET', '/api/search?q=number 7')).body as SearchResponse;
    expect(r.hits.map((x) => x.message.text).sort()).toEqual(['message number 7', 'message number 70', 'message number 71', 'message number 72', 'message number 73', 'message number 74', 'message number 75'].sort());
    expect((await c.req('GET', '/api/search?q=a')).status).toBe(400);
  });

  it('streams media with Range support and a safe content-type policy', async () => {
    const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i & 255));
    const img = await seedMedia(h, data, 'image/jpeg', 'photo.jpg');
    let r = await h.app.inject({ method: 'GET', url: `/api/media/${img}`, headers: { cookie: c.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['content-disposition']).toMatch(/^inline/);
    expect(r.headers['content-security-policy']).toMatch(/sandbox/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.rawPayload.equals(data)).toBe(true);

    r = await h.app.inject({ method: 'GET', url: `/api/media/${img}`, headers: { cookie: c.cookie, range: 'bytes=70000-140000' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 70000-140000/${data.length}`);
    expect(r.rawPayload.equals(data.subarray(70000, 140001))).toBe(true);

    r = await h.app.inject({ method: 'GET', url: `/api/media/${img}`, headers: { cookie: c.cookie, range: 'bytes=-100' } });
    expect(r.rawPayload.equals(data.subarray(data.length - 100))).toBe(true);

    r = await h.app.inject({ method: 'GET', url: `/api/media/${img}`, headers: { cookie: c.cookie, range: 'bytes=999999-' } });
    expect(r.statusCode).toBe(416);

    const html = await seedMedia(h, Buffer.from('<script>alert(1)</script>'), 'text/html', '../../evil".html');
    r = await h.app.inject({ method: 'GET', url: `/api/media/${html}`, headers: { cookie: c.cookie } });
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="evil.html"/);

    const svg = await seedMedia(h, Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml', 'x.svg');
    r = await h.app.inject({ method: 'GET', url: `/api/media/${svg}`, headers: { cookie: c.cookie } });
    expect(r.headers['content-type']).toBe('application/octet-stream');

    r = await h.app.inject({ method: 'GET', url: `/api/media/${img}` });
    expect(r.statusCode).toBe(401);
    r = await h.app.inject({ method: 'GET', url: `/api/media/99999`, headers: { cookie: c.cookie } });
    expect(r.statusCode).toBe(404);
  });

  it('validates content types and filenames', () => {
    expect(inlineContentType('audio/ogg; codecs=opus')).toBe('audio/ogg; codecs=opus');
    expect(inlineContentType('video/mp4')).toBe('video/mp4');
    expect(inlineContentType('image/svg+xml')).toBeNull();
    expect(inlineContentType('text/html')).toBeNull();
    expect(inlineContentType('application/pdf')).toBeNull();
    expect(inlineContentType('audio/ogg; codecs="x"; evil=<script>')).toBe('audio/ogg; codecs="x"');
    expect(safeFilename('../../etc/passwd', 'f')).toBe('passwd');
    expect(safeFilename('a"b;c\r\n.txt', 'f')).toBe('abc.txt');
    expect(safeFilename(null, 'fallback')).toBe('fallback');
  });

  it('updates settings with validation', async () => {
    let r = await c.req('PUT', '/api/settings', { mediaMaxMb: 5 });
    expect(r.status).toBe(200);
    expect(r.body.mediaMaxMb).toBe(5);
    r = await c.req('PUT', '/api/settings', { mediaMaxMb: 999999 });
    expect(r.status).toBe(400);
    r = await c.req('PUT', '/api/settings', { unknown: true });
    expect(r.status).toBe(400);
    expect((await c.req('GET', '/api/settings')).body.mediaMaxMb).toBe(5);
  });

  it('requires WhatsApp to be ready before completing onboarding (unless forced)', async () => {
    expect((await c.req('POST', '/api/onboarding/complete', {})).status).toBe(409);
    expect((await c.req('POST', '/api/onboarding/complete', { force: true })).status).toBe(200);
    expect((await c.refreshState()).onboardingComplete).toBe(true);
  });

  it('wipes all logged data only with the password', async () => {
    await seedMedia(h, Buffer.from('x'), 'image/png', null);
    expect((await c.req('POST', '/api/data/wipe', { password: 'wrong-password-12' })).status).toBe(401);
    expect((await c.req('POST', '/api/data/wipe', { password: PASSWORD })).status).toBe(200);
    expect((await c.req('GET', '/api/chats')).body).toEqual([]);
    expect(await fs.readdir(h.ctx.config.mediaDir)).toEqual([]);
    expect((await c.req('GET', '/api/audit')).body.some((a: { event: string }) => a.event === 'data_wiped')).toBe(true);
    expect((await c.refreshState()).authenticated).toBe(true);
  });

  it('streams server-sent events to authenticated clients only', async () => {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const get = (headers: Record<string, string>) =>
      new Promise<{ status: number; first: string; res: http.IncomingMessage }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
          if (res.statusCode !== 200) return resolve({ status: res.statusCode ?? 0, first: '', res });
          let buf = '';
          res.on('data', (d: Buffer) => {
            buf += d.toString();
            if (buf.includes('\n\n') && buf.includes('event:')) resolve({ status: 200, first: buf, res });
          });
        });
        req.on('error', reject);
      });
    const anon = await get({});
    expect(anon.status).toBe(401);
    const ok = await get({ cookie: c.cookie });
    expect(ok.status).toBe(200);
    expect(ok.first).toMatch(/event: wa_state/);
    const got = new Promise<string>((resolve) => ok.res.on('data', (d: Buffer) => resolve(d.toString())));
    h.ctx.events.emit({ type: 'chat_update', chatId: CHAT });
    expect(await got).toMatch(/event: chat_update/);
    ok.res.destroy();
  });

  it('bridges VNC over an authenticated same-origin WebSocket', async () => {
    const rfb = net.createServer((sock) => {
      sock.write('RFB 003.008\n');
      sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    await new Promise<void>((r) => rfb.listen(0, '127.0.0.1', () => r()));
    const vncPort = (rfb.address() as AddressInfo).port;
    await h.close();
    h = await makeHarness({ CHROMIUM_HOST: '127.0.0.1', VNC_PORT: String(vncPort) });
    c = h.client();
    await c.signup();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/api/vnc`;

    const attempt = (headers: Record<string, string>) =>
      new Promise<{ ok: boolean; status?: number; ws?: WebSocket; first?: Buffer }>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
        ws.on('message', (d: Buffer) => resolve({ ok: true, ws, first: d }));
        ws.on('error', () => resolve({ ok: false }));
      });

    expect((await attempt({ origin: ORIGIN })).status).toBe(401);
    expect((await attempt({ origin: 'https://evil.test', cookie: c.cookie })).status).toBe(403);
    const good = await attempt({ origin: ORIGIN, cookie: c.cookie });
    expect(good.ok).toBe(true);
    expect(good.first!.toString()).toBe('RFB 003.008\n');
    const echoed = new Promise<string>((resolve) => good.ws!.once('message', (d: Buffer) => resolve(d.toString())));
    good.ws!.send(Buffer.from('RFB 003.008\n'));
    expect(await echoed).toBe('echo:RFB 003.008\n');
    good.ws!.close();
    const creds = await c.req('GET', '/api/vnc/credentials');
    expect(creds.body).toEqual({ password: 'vnc-pass-123' });
    rfb.close();
  });

  it('never stores plaintext message content in the database file', async () => {
    h.ctx.repo.db.pragma('wal_checkpoint(TRUNCATE)');
    const files = await fs.readdir(h.dir);
    let blob = Buffer.alloc(0);
    for (const f of files) {
      const p = path.join(h.dir, f);
      if ((await fs.stat(p)).isFile()) blob = Buffer.concat([blob, await fs.readFile(p)]);
    }
    for (const needle of ['message number', 'pineapples', 'Ali Veli', 'edited twenty']) {
      expect(blob.includes(Buffer.from(needle)), needle).toBe(false);
    }
  });
});
