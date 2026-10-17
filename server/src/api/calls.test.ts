import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CallInfo, ServerEvent } from '../../../shared/api.js';
import { NullWa, type WaController } from '../context.js';
import { ORIGIN, makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import type { CallBridge, RawCall } from '../wa/callbridge.js';
import { CallService, endReason, mapCallState } from '../wa/calls.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import type { RawMsg } from '../wa/mapper.js';
import { PageOpError } from '../wa/walbridge.js';

const CHAT = '905551112233@c.us';
const LID = '123456789012345@lid';
const GROUP = '120363000000000001@g.us';
const waApi: WaApi = {
  getChat: async () => ({ name: 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
};
const msg = (remote: string, id: string): RawMsg => ({
  id: { fromMe: false, remote, id, _serialized: `false_${remote}_${id}` },
  type: 'chat',
  body: 'hi',
  t: 1_700_000_000,
  from: remote,
  ...(remote.endsWith('@g.us') ? { author: CHAT } : {}),
});

const raw = (over: Partial<RawCall>): RawCall => ({
  id: 'C1',
  state: 3,
  outgoing: false,
  isVideo: false,
  isGroup: false,
  peer: LID,
  peerAlt: CHAT,
  group: null,
  peerBusy: false,
  failedReason: null,
  logResult: null,
  everConnected: false,
  userEnded: false,
  removed: false,
  ...over,
});

/** The page side (callpage.ts over CDP), simulated: WhatsApp Web's call models answer like the real ones. */
class FakeBridge {
  ops: { op: string; args: any }[] = [];
  audio: Buffer[] = [];
  on = false;
  fail: PageOpError | null = null;
  constructor(private readonly svc: () => CallService) {}
  async call(op: string, args: any): Promise<unknown> {
    this.ops.push({ op, args });
    if (this.fail) throw this.fail;
    if (op === 'setBridge') this.on = args.on;
    if (op === 'reject') this.svc().onCall(raw({ id: args.callId, state: 0, removed: true, logResult: 3, userEnded: true }));
    if (op === 'hangup') this.svc().onCall(raw({ id: args.callId, state: 13, everConnected: true, userEnded: true }));
    return true;
  }
  async gesture(op: string, args: any): Promise<unknown> {
    this.ops.push({ op, args });
    if (this.fail) throw this.fail;
    if (op === 'start') return raw({ id: 'OUT1', state: 1, outgoing: true, peer: args.chatId, peerAlt: null });
    if (op === 'accept') this.svc().onCall(raw({ id: args.callId, state: 4 }));
    return true;
  }
  audioIn(pcm: Buffer): void {
    this.audio.push(pcm);
  }
  names(): string[] {
    return this.ops.map((o) => o.op);
  }
}

class CallWa extends NullWa {
  override readonly calls: CallService;
  bridge: FakeBridge | null;
  constructor(ctx: Harness['ctx']) {
    super();
    this.bridge = new FakeBridge(() => this.calls);
    this.calls = new CallService(ctx, () => this.bridge as unknown as CallBridge | null);
  }
}

describe('call states', () => {
  it('maps WhatsApp Web call states', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 0, null, 99].map(mapCallState)).toEqual([
      'calling', 'ringing', 'incoming', 'connecting', 'connecting', 'active', 'elsewhere', 'incoming', 'active',
      'calling', 'ended', 'calling', 'ended', null, null,
    ]);
  });
  it('explains why a call ended', () => {
    const info = { direction: 'outgoing', connectedAt: null } as CallInfo;
    expect(endReason(raw({ peerBusy: true }), info, 'ended')).toBe('busy');
    expect(endReason(raw({ logResult: 3 }), info, 'ended')).toBe('declined');
    expect(endReason(raw({ logResult: 5 }), info, 'ended')).toBe('unavailable');
    expect(endReason(raw({}), info, 'elsewhere')).toBe('elsewhere');
    expect(endReason(raw({ userEnded: true }), info, 'ended')).toBe('canceled');
    expect(endReason(raw({}), { ...info, connectedAt: 1 }, 'ended')).toBe('completed');
    expect(endReason(raw({}), { ...info, direction: 'incoming' }, 'ended')).toBe('missed');
  });
});

describe('calls API', () => {
  let h: Harness;
  let c: TestClient;
  let wa: CallWa;
  let events: ServerEvent[];

  beforeEach(async () => {
    h = await makeHarness({}, { wa: (ctx) => (wa = new CallWa(ctx)) as WaController });
    c = h.client();
    await c.signup();
    const ingest = new Ingest(h.ctx, waApi, { enqueue: () => undefined });
    await ingest.message(msg(CHAT, 'M1'), 'live');
    await ingest.message(msg(GROUP, 'G1'), 'live');
    events = [];
    h.ctx.events.subscribe((ev) => events.push(ev));
  });
  afterEach(async () => {
    await h.close();
  });

  const callEvents = () => events.flatMap((e) => (e.type === 'call' ? [e.call] : []));
  const tick = () => new Promise((r) => setTimeout(r, 20));

  async function listen(): Promise<string> {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    return `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/api/calls/audio`;
  }

  /** Connects the audio WebSocket; resolves with the first message (or the close/HTTP status). */
  function audio(url: string, headers: Record<string, string> = { origin: ORIGIN, cookie: c.cookie }) {
    return new Promise<{ ws: WebSocket; first?: string; status?: number; closed?: number; frames: Buffer[]; closedP: Promise<number> }>((resolve) => {
      const ws = new WebSocket(url, { headers });
      const frames: Buffer[] = [];
      let closeResolve: (n: number) => void = () => undefined;
      const closedP = new Promise<number>((r) => (closeResolve = r));
      ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode, frames, closedP }));
      ws.on('message', (d: Buffer, isBinary: boolean) => {
        if (isBinary) frames.push(d);
        else resolve({ ws, first: d.toString(), frames, closedP });
      });
      ws.on('close', (code) => {
        closeResolve(code);
        resolve({ ws, closed: code, frames, closedP });
      });
      ws.on('error', () => undefined);
    });
  }

  it('needs a session, the CSRF token and our origin', async () => {
    const anon = h.client();
    expect((await anon.req('GET', '/api/calls/current')).status).toBe(401);
    expect((await c.req('POST', `/api/chats/${CHAT}/call`, {}, { csrf: null })).status).toBe(403);
    expect((await c.req('POST', `/api/chats/${CHAT}/call`, {}, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await c.req('POST', '/api/calls/C1/hangup', {}, { csrf: null })).status).toBe(403);
    const url = await listen();
    expect((await audio(url, { origin: ORIGIN })).status).toBe(401);
    expect((await audio(url, { origin: 'https://evil.test', cookie: c.cookie })).status).toBe(403);
    expect(wa.bridge!.ops).toEqual([]);
  });

  it('answers an incoming call and bridges its audio both ways', async () => {
    expect((await c.req('GET', '/api/calls/current')).body).toEqual({ call: null, available: true });
    wa.calls.onCall(raw({}));
    const ringing = callEvents()[0]!;
    // The chat we log (phone-number id) is preferred over the call's LID; SSE events carry no names.
    expect(ringing).toMatchObject({ id: 'C1', direction: 'incoming', state: 'incoming', chatId: CHAT, audio: false });
    expect(ringing.name).toBeUndefined();
    expect((await c.req('GET', '/api/calls/current')).body.call).toMatchObject({ state: 'incoming', name: 'Ali Veli' });

    const acc = await c.req('POST', '/api/calls/C1/accept', {});
    expect(acc.status).toBe(200);
    expect(wa.bridge!.names()).toEqual(['accept']);
    expect(acc.body.state).toBe('connecting');

    const url = await listen();
    const a = await audio(url);
    expect(JSON.parse(a.first!)).toEqual({ type: 'hello', sampleRate: 16000, channels: 1, format: 's16le', callId: 'C1' });
    await tick();
    expect(wa.bridge!.on).toBe(true);
    wa.calls.onCall(raw({ state: 6, everConnected: true }));
    expect(wa.calls.current()).toMatchObject({ state: 'active', audio: true });
    expect(wa.calls.current()!.connectedAt).toBeGreaterThan(0);

    a.ws.send(Buffer.alloc(640, 1));
    wa.calls.onPageAudio(Buffer.alloc(640, 2));
    await tick();
    expect(wa.bridge!.audio).toEqual([Buffer.alloc(640, 1)]);
    expect(a.frames).toEqual([Buffer.alloc(640, 2)]);

    // WhatsApp reports setup states again after connecting: stays active.
    wa.calls.onCall(raw({ state: 5, everConnected: true }));
    expect(wa.calls.current()!.state).toBe('active');

    expect((await c.req('POST', '/api/calls/C1/hangup', {})).status).toBe(200);
    expect(await a.closedP).toBe(1000);
    expect(callEvents().at(-1)).toMatchObject({ state: 'ended', endReason: 'completed' });
    expect(wa.bridge!.on).toBe(false);
    expect((await c.req('POST', '/api/calls/C1/hangup', {})).status).toBe(404);
    const audit = (await c.req('GET', '/api/audit')).body as { event: string }[];
    expect(audit.some((e) => e.event === 'call_accepted')).toBe(true);
  });

  it('declines a call; one answered on another device just ends', async () => {
    wa.calls.onCall(raw({}));
    expect((await c.req('POST', '/api/calls/C1/reject', {})).status).toBe(200);
    expect(callEvents().at(-1)).toMatchObject({ state: 'ended', endReason: 'declined' });
    expect((await c.req('POST', '/api/calls/C1/accept', {})).status).toBe(404);

    wa.calls.onCall(raw({ id: 'C2' }));
    wa.calls.onCall(raw({ id: 'C2', state: 7 }));
    expect(callEvents().at(-1)).toMatchObject({ id: 'C2', state: 'ended', endReason: 'elsewhere' });
    // A model first seen already over (e.g. from history) is not a call to show.
    wa.calls.onCall(raw({ id: 'OLD', state: 0 }));
    expect(callEvents().some((x) => x.id === 'OLD')).toBe(false);
  });

  it('places a voice call to a one-to-one chat', async () => {
    const r = await c.req('POST', `/api/chats/${CHAT}/call`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'OUT1', direction: 'outgoing', state: 'calling', chatId: CHAT, name: 'Ali Veli' });
    expect(wa.bridge!.ops[0]).toEqual({ op: 'start', args: { chatId: CHAT } });
    expect((await c.req('POST', `/api/chats/${CHAT}/call`, {})).status).toBe(409); // one call at a time

    // Audio flows while it rings (WhatsApp plays its own ringback through the page).
    const a = await audio(await listen());
    await tick();
    expect(wa.bridge!.on).toBe(true);
    wa.calls.onCall(raw({ id: 'OUT1', state: 2, outgoing: true, peer: CHAT, peerAlt: null }));
    expect(wa.calls.current()!.state).toBe('ringing');
    wa.calls.onCall(raw({ id: 'OUT1', state: 0, outgoing: true, removed: true, peer: CHAT, peerBusy: true }));
    expect(callEvents().at(-1)).toMatchObject({ state: 'ended', endReason: 'busy' });
    expect(await a.closedP).toBe(1000);
    const audit = (await c.req('GET', '/api/audit')).body as { event: string }[];
    expect(audit.some((e) => e.event === 'call_started')).toBe(true);
  });

  it('validates calls and reports what WhatsApp says', async () => {
    expect((await c.req('POST', `/api/chats/${GROUP}/call`, {})).status).toBe(409);
    expect((await c.req('POST', '/api/chats/905550000000@c.us/call', {})).status).toBe(404);
    expect((await c.req('POST', `/api/chats/${CHAT}/call`, { video: true })).status).toBe(400);
    expect((await c.req('POST', '/api/calls/bad%20id/accept', {})).status).toBe(400);
    expect((await c.req('POST', '/api/calls/NOPE/accept', {})).status).toBe(404);
    wa.bridge!.fail = new PageOpError('unsupported', 'WhatsApp Web can’t call from this account or browser (calling_disabled).');
    const r = await c.req('POST', `/api/chats/${CHAT}/call`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'calls_unsupported', message: 'WhatsApp Web can’t call from this account or browser (calling_disabled).' });
    wa.bridge = null;
    expect((await c.req('POST', `/api/chats/${CHAT}/call`, {})).status).toBe(503);
    expect((await c.req('GET', '/api/calls/current')).body).toEqual({ call: null, available: false });
  });

  it('allows one audio connection, checks frames and ends with the call', async () => {
    const url = await listen();
    expect((await audio(url)).closed).toBe(4004); // no call
    wa.calls.onCall(raw({}));
    await c.req('POST', '/api/calls/C1/accept', {});
    const first = await audio(url);
    expect(first.first).toBeDefined();
    const second = await audio(url);
    expect(second.first).toBeDefined();
    expect(await first.closedP).toBe(4000); // replaced
    second.ws.send(Buffer.alloc(641));
    expect(await second.closedP).toBe(1007); // odd length
    const third = await audio(url);
    for (let i = 0; i < 20; i++) third.ws.send(Buffer.alloc(6400));
    expect(await third.closedP).toBe(1008); // far faster than real time
    expect(wa.calls.current()!.audio).toBe(false);
  });

  it('ends a call when WhatsApp goes away', async () => {
    wa.calls.onCall(raw({}));
    wa.calls.onPageLost();
    expect(callEvents().at(-1)).toMatchObject({ state: 'ended', endReason: 'failed' });
  });
});
