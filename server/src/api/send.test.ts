import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SendMediaKind } from '../../../shared/api.js';
import { NullWa, type AppContext, type WaController, type WaSender } from '../context.js';
import { ORIGIN, makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import type { RawMsg } from '../wa/mapper.js';
import { Sender, toAppError } from '../wa/sender.js';
import { PageOpError, type WalPage } from '../wa/walbridge.js';
import { cleanFilename, UPLOAD_MAX_BYTES } from './send.js';

const CHAT = '905551112233@c.us';
const OTHER = '905559998877@c.us';
const text = (msgId: string, body: string, over: RawMsg = {}, remote = CHAT, fromMe = false): RawMsg => ({
  id: { fromMe, remote, id: msgId, _serialized: `${fromMe}_${remote}_${msgId}` },
  type: 'chat',
  body,
  t: 1_700_000_000,
  from: fromMe ? '905550000001@c.us' : remote,
  ack: 1,
  ...over,
});
const waApi: WaApi = {
  getChat: async () => ({ name: 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
};

type Call = { op: string; args: unknown[] };

class FakeWa extends NullWa {
  calls: Call[] = [];
  fail: Error | null = null;
  override readonly sender: WaSender;
  constructor() {
    super();
    const rec =
      (op: string, ret: unknown = undefined) =>
      async (...args: unknown[]) => {
        this.calls.push({ op, args });
        if (this.fail) throw this.fail;
        return ret;
      };
    this.sender = {
      sendText: rec('sendText', { id: 'true_905551112233@c.us_SENT1' }) as WaSender['sendText'],
      sendMedia: rec('sendMedia', { id: null }) as WaSender['sendMedia'],
      react: rec('react') as WaSender['react'],
      revoke: rec('revoke') as WaSender['revoke'],
      edit: rec('edit') as WaSender['edit'],
      markRead: rec('markRead') as WaSender['markRead'],
      openChat: rec('openChat', '905551234567@c.us') as WaSender['openChat'],
    };
  }
  ops(op: string): unknown[][] {
    return this.calls.filter((c) => c.op === op).map((c) => c.args);
  }
}

async function upload(c: TestClient, h: Harness, data: Buffer, headers: Record<string, string> = {}) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { origin: ORIGIN, cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/octet-stream', ...headers },
    payload: data,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
}

describe('send API', () => {
  let h: Harness;
  let c: TestClient;
  let wa: FakeWa;

  beforeEach(async () => {
    wa = new FakeWa();
    h = await makeHarness({}, { wa: () => wa as WaController });
    c = h.client();
    await c.signup();
    const ingest = new Ingest(h.ctx, waApi, { enqueue: () => undefined });
    await ingest.message(text('M1', 'hello'), 'live');
    await ingest.message(text('MINE', 'my message', {}, CHAT, true), 'live');
    await ingest.message(text('O1', 'elsewhere', {}, OTHER), 'live');
  });
  afterEach(async () => {
    await h.close();
  });

  it('sends text and replies, then marks the chat as read', async () => {
    const r = await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'Merhaba 👋', quotedId: `false_${CHAT}_M1` });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'true_905551112233@c.us_SENT1' });
    expect(wa.ops('sendText')).toEqual([[CHAT, 'Merhaba 👋', `false_${CHAT}_M1`]]);
    await new Promise((res) => setTimeout(res, 10));
    expect(wa.ops('markRead')).toEqual([[CHAT]]);
  });

  it('validates text, chat and quoted message', async () => {
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: '   ' })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'x'.repeat(65_537) })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi', extra: 1 })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/123456@c.us/send`, { text: 'hi' })).status).toBe(404);
    // A quote must belong to the same chat.
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi', quotedId: `false_${OTHER}_O1` })).status).toBe(404);
    expect(wa.ops('sendText')).toEqual([]);
  });

  it('requires a session, the CSRF token and our origin', async () => {
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' }, { csrf: null })).status).toBe(403);
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' }, { origin: 'https://evil.test' })).status).toBe(403);
    const anon = h.client();
    expect((await anon.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' })).status).toBe(401);
    const up = await h.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { origin: ORIGIN, cookie: c.cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc'),
    });
    expect(up.statusCode).toBe(403);
    expect(wa.calls).toEqual([]);
  });

  it('uploads a file and sends it once, only from the same session', async () => {
    const data = Buffer.from('fake jpeg bytes');
    const up = await upload(c, h, data, { 'x-filename': encodeURIComponent('../tatil fotoğrafı.jpg'), 'x-file-type': 'image/jpeg' });
    expect(up.status).toBe(200);
    expect(up.body.size).toBe(data.length);
    expect(up.body.uploadId).toMatch(/^[0-9a-f]{32}$/);

    const other = h.client();
    await other.login();
    expect((await other.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto' })).status).toBe(404);

    const r = await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto', caption: 'deniz' });
    expect(r.status).toBe(200);
    const [args] = wa.ops('sendMedia');
    expect(args![0]).toBe(CHAT);
    expect(args![1]).toMatchObject({ mime: 'image/jpeg', filename: 'tatil fotoğrafı.jpg' });
    expect((args![1] as { data: Buffer }).data.equals(data)).toBe(true);
    expect(args!.slice(2)).toEqual(['auto' satisfies SendMediaKind, 'deniz', null]);
    // Consumed.
    expect((await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto' })).status).toBe(404);
  });

  it('rejects bad uploads', async () => {
    expect((await upload(c, h, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(c, h, Buffer.alloc(UPLOAD_MAX_BYTES + 1))).status).toBe(413);
    // A made-up type is replaced by octet-stream rather than trusted.
    const up = await upload(c, h, Buffer.from('x'), { 'x-file-type': 'text/html\r\nX-Evil: 1' });
    expect(up.status).toBe(200);
    await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'document' });
    expect((wa.ops('sendMedia')[0]![1] as { mime: string }).mime).toBe('application/octet-stream');
    // JSON is not a file.
    expect((await c.req('POST', '/api/uploads', { data: 'x' })).status).toBe(400);
    // At most a few files wait at once.
    for (let i = 0; i < 4; i++) expect((await upload(c, h, Buffer.from('y'))).status).toBe(200);
    expect((await upload(c, h, Buffer.from('z'))).status).toBe(409);
  });

  it('reacts, deletes for everyone and edits own messages only', async () => {
    const mine = `true_${CHAT}_MINE`;
    const theirs = `false_${CHAT}_M1`;
    expect((await c.req('POST', `/api/messages/${theirs}/react`, { emoji: '❤️' })).status).toBe(200);
    expect((await c.req('POST', `/api/messages/${theirs}/react`, { emoji: '' })).status).toBe(200);
    expect((await c.req('POST', `/api/messages/${theirs}/react`, { emoji: '<b>' })).status).toBe(400);
    expect(wa.ops('react')).toEqual([
      [theirs, '❤️'],
      [theirs, ''],
    ]);
    expect((await c.req('POST', `/api/messages/${mine}/edit`, { text: 'fixed' })).status).toBe(200);
    expect((await c.req('POST', `/api/messages/${theirs}/edit`, { text: 'nope' })).status).toBe(409);
    expect((await c.req('POST', `/api/messages/${mine}/revoke`)).status).toBe(200);
    expect((await c.req('POST', `/api/messages/nope_x/revoke`)).status).toBe(404);
    expect(wa.ops('edit')).toEqual([[mine, 'fixed']]);
    expect(wa.ops('revoke')).toEqual([[mine]]);
  });

  it('opens a chat by phone number and marks chats read', async () => {
    const r = await c.req('POST', '/api/chats/new', { phone: '+90 555 123 45 67' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chatId: '905551234567@c.us' });
    expect((await c.req('POST', '/api/chats/new', { phone: 'abc' })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/${CHAT}/read`)).status).toBe(200);
  });

  it('passes WhatsApp errors on with safe messages', async () => {
    wa.fail = toAppError(new PageOpError('not_allowed', 'This message can no longer be deleted for everyone.'));
    const r = await c.req('POST', `/api/messages/true_${CHAT}_MINE/revoke`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('This message can no longer be deleted for everyone.');
    wa.fail = toAppError(new Error('internal detail /secret/path'));
    const r2 = await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' });
    expect(r2.status).toBe(502);
    expect(r2.raw).not.toContain('secret');
  });
});

describe('send API without WhatsApp', () => {
  it('answers 503 when WhatsApp is not connected', async () => {
    const h = await makeHarness();
    try {
      const c = h.client();
      await c.signup();
      await new Ingest(h.ctx, waApi, { enqueue: () => undefined }).message(text('M1', 'hello'), 'live');
      const r = await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('unavailable');
    } finally {
      await h.close();
    }
  });
});

describe('Sender', () => {
  let h: Harness;
  let ctx: AppContext;
  beforeEach(async () => {
    h = await makeHarness();
    ctx = h.ctx;
    await h.client().signup();
  });
  afterEach(async () => {
    await h.close();
  });

  function fakePage(onCall: (op: string, args: Record<string, unknown>) => unknown): { page: WalPage; ops: string[] } {
    const ops: string[] = [];
    const page = {
      call: async (op: string, args: Record<string, unknown>) => {
        ops.push(op);
        return onCall(op, args);
      },
    } as unknown as WalPage;
    return { page, ops };
  }

  it('streams the file to the page in chunks and stores the sent media for the logged message', async () => {
    const id = `true_${CHAT}_SENTIMG`;
    const data = Buffer.alloc(2.5 * 1024 * 1024, 7);
    let received = 0;
    const { page, ops } = fakePage((op, args) => {
      if (op === 'uploadBegin') return 'tok';
      if (op === 'uploadChunk') received += Buffer.from(String(args.b64), 'base64').length;
      if (op === 'sendMedia') return { id };
      return true;
    });
    const sender = new Sender(ctx, () => page, async () => undefined);
    // The message as ingest logged it when WhatsApp added it (before the upload had finished).
    await new Ingest(ctx, waApi, { enqueue: () => undefined }).message(text('SENTIMG', '', { type: 'image', mimetype: 'image/jpeg', size: data.length }, CHAT, true), 'live');
    expect(ctx.repo.getMessage(id)!.media_status).toBe('unavailable');

    expect(await sender.sendMedia(CHAT, { data, mime: 'image/jpeg', filename: null }, 'auto', null, null)).toEqual({ id });
    expect(ops).toEqual(['uploadBegin', 'uploadChunk', 'uploadChunk', 'uploadChunk', 'sendMedia']);
    expect(received).toBe(data.length);
    for (let i = 0; i < 50 && ctx.repo.getMessage(id)!.media_status !== 'downloaded'; i++) await new Promise((r) => setTimeout(r, 20));
    const row = ctx.repo.getMessage(id)!;
    expect(row.media_status).toBe('downloaded');
    expect(row.media_size).toBe(data.length);
  });

  it('drops the upload in the page when sending fails', async () => {
    const { page, ops } = fakePage((op) => {
      if (op === 'uploadBegin') return 'tok';
      if (op === 'sendMedia') throw new PageOpError('send_failed', 'WhatsApp could not send it (error_upload).');
      return true;
    });
    const sender = new Sender(ctx, () => page, async () => undefined);
    await expect(sender.sendMedia(CHAT, { data: Buffer.from('x'), mime: 'image/png', filename: null }, 'auto', null, null)).rejects.toMatchObject({
      statusCode: 502,
      code: 'send_failed',
    });
    expect(ops).toEqual(['uploadBegin', 'uploadChunk', 'sendMedia', 'uploadDrop']);
  });

  it('caps sends per hour', async () => {
    const { page } = fakePage(() => ({ id: null }));
    const sender = new Sender(ctx, () => page, async () => undefined);
    for (let i = 0; i < 300; i++) await sender.sendText(CHAT, 'x', null);
    await expect(sender.sendText(CHAT, 'x', null)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('is unavailable without a WhatsApp page', async () => {
    const sender = new Sender(ctx, () => null, async () => undefined);
    await expect(sender.react('x_y_z', '👍')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('cleanFilename', () => {
  it('keeps the name, drops paths and control characters', () => {
    expect(cleanFilename(encodeURIComponent('C:\\Users\\x\\rapor.pdf'))).toBe('rapor.pdf');
    expect(cleanFilename(encodeURIComponent('a\u0000b\nc.txt'))).toBe('abc.txt');
    expect(cleanFilename('%E0%A4%A')).toBeNull();
    expect(cleanFilename('..')).toBeNull();
    expect(cleanFilename(undefined)).toBeNull();
  });
});
