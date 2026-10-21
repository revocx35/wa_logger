import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullWa, type WaController } from '../context.js';
import { makeHarness, type Harness } from '../testutil/harness.js';
import type { CallBridge, RawCall } from './callbridge.js';
import { CallService } from './calls.js';
import { normalizePhone, phoneDigits } from './blocklist.js';
import { Ingest, type WaApi } from './ingest.js';
import type { RawMsg } from './mapper.js';
import { Sync } from './sync.js';

const AHMET = '905559990001@c.us';
const ALI = '905551112233@c.us';
const AHMET_LID = '99887766554433@lid';
const GROUP = '120363000000@g.us';
const TOKEN = 'internal-token-0123456789-abcdefghij';

const rid = (msgId: string, remote: string, fromMe = false, participant?: string) => ({
  fromMe,
  remote,
  id: msgId,
  participant,
  _serialized: `${fromMe}_${remote}_${msgId}${participant ? `_${participant}` : ''}`,
});
const text = (msgId: string, remote: string, body = 'hello', over: RawMsg = {}): RawMsg => ({
  id: rid(msgId, remote, false, over.participant as string | undefined),
  type: 'chat',
  body,
  t: 1_700_000_000,
  from: remote,
  ack: 1,
  ...over,
});

describe('phone numbers', () => {
  it('compares digits only', () => {
    expect(normalizePhone('+90 555 999 00 01')).toBe('905559990001');
    expect(normalizePhone('00905559990001')).toBe('905559990001');
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(phoneDigits(AHMET)).toBe('905559990001');
    expect(phoneDigits(AHMET_LID)).toBeNull();
    expect(phoneDigits(GROUP)).toBeNull();
  });
});

describe('blocked contacts', () => {
  let h: Harness;
  let ingest: Ingest;
  let enqueued: string[];
  // The page's view of a contact: the display name can change, the number cannot.
  let names: Record<string, string>;
  const api: WaApi = {
    getChat: async (id) => ({ name: names[id] ?? null, timestamp: 1_700_000_000_000, archived: false, pinned: false, muted: false }),
    getContact: async (id) => ({
      name: names[id] ?? null,
      pushname: names[id] ?? null,
      phone: id === AHMET_LID ? '+905559990001' : undefined,
      isMe: false,
      isBusiness: false,
    }),
  };
  const logged = (id: string) => !!h.ctx.repo.getMessage(id);

  beforeEach(async () => {
    h = await makeHarness();
    await h.client().signup();
    names = { [AHMET]: 'Ahmet', [ALI]: 'Ali', [AHMET_LID]: 'Ahmet' };
    enqueued = [];
    ingest = new Ingest(h.ctx, api, { enqueue: (id) => enqueued.push(id) });
  });
  afterEach(async () => {
    await h.close();
  });

  it('logs nothing from a blocked number, whatever the contact is called', async () => {
    await ingest.message(text('A0', AHMET, 'before'), 'live');
    h.ctx.blocks.replace(['905559990001']);
    names[AHMET] = 'Ahmet Reis';
    expect(await ingest.message(text('A1', AHMET), 'live')).toBeNull();
    expect(await ingest.message({ ...text('A2', AHMET), id: rid('A2', AHMET, true), from: undefined }, 'live')).toBeNull();
    expect(logged('false_' + AHMET + '_A1')).toBe(false);
    expect(logged('true_' + AHMET + '_A2')).toBe(false);
    // Someone else is still logged, and what was logged before stays.
    expect(await ingest.message(text('B1', ALI), 'live')).not.toBeNull();
    expect(logged('false_' + AHMET + '_A0')).toBe(true);
  });

  it('does not record a deletion, edit or reaction either, and skips the contact in groups', async () => {
    h.ctx.blocks.replace(['905559990001']);
    await ingest.revoke({ ...text('R1', AHMET), type: 'revoked' }, text('R1', AHMET));
    expect(h.ctx.repo.getMessage(`false_${AHMET}_R1`)).toBeUndefined();
    await ingest.edit(text('E1', AHMET, 'new'), 'new', 'old');
    expect(h.ctx.repo.getMessage(`false_${AHMET}_E1`)).toBeUndefined();
    // In a group: his messages are skipped, the others' are logged.
    expect(await ingest.message(text('G1', GROUP, 'x', { participant: AHMET, author: AHMET }), 'live')).toBeNull();
    expect(await ingest.message(text('G2', GROUP, 'y', { participant: ALI, author: ALI }), 'live')).not.toBeNull();
    expect(h.ctx.repo.getChat(AHMET)).toBeUndefined();
  });

  it('resolves a LID to its number and blocks it; an unresolvable LID is held back, not logged', async () => {
    h.ctx.blocks.replace(['905559990001']);
    expect(await ingest.message(text('L1', AHMET_LID), 'live')).toBeNull();
    expect(h.ctx.blocks.phoneOf(AHMET_LID)).toBe('905559990001');
    // Nothing about the blocked contact went into the user's own tables.
    expect(h.ctx.repo.getContact(AHMET_LID)).toBeUndefined();
    // A LID the page cannot map: not logged while the list is in use.
    const blind = new Ingest(h.ctx, { ...api, getContact: async () => null }, { enqueue: () => undefined });
    expect(await blind.message(text('L2', '1234567890123@lid'), 'live')).toBeNull();
    // With nothing blocked everything is logged again.
    h.ctx.blocks.replace([]);
    expect(await blind.message(text('L3', '1234567890123@lid'), 'live')).not.toBeNull();
  });

  it('skips the blocked chat in history and reconcile', async () => {
    h.ctx.blocks.replace(['905559990001']);
    const fetched: string[] = [];
    const sync = new Sync(
      h.ctx,
      ingest,
      {
        listChats: async () => [AHMET, ALI].map((id) => ({ id, name: names[id]!, timestamp: 1_700_000_000_000, archived: false, pinned: false, muted: false })),
        fetchMessages: async (id) => {
          fetched.push(id);
          return [text('H1', id)];
        },
      },
      () => undefined,
    );
    await sync.historyPass();
    await sync.reconcile();
    expect(fetched.every((id) => id === ALI)).toBe(true);
    expect(h.ctx.repo.getChat(AHMET)).toBeUndefined();
    expect(h.ctx.repo.getChat(ALI)).toBeDefined();
  });

  it('lists contacts for the admin with names, and keeps names out of the plain database', async () => {
    await ingest.message(text('A0', AHMET, 'hi'), 'live');
    await ingest.message(text('B0', ALI, 'hi'), 'live');
    const list = h.ctx.blocks.directory();
    expect(list).toEqual(expect.arrayContaining([{ phone: '905559990001', label: 'Ahmet' }, { phone: '905551112233', label: 'Ali' }]));
    const raw = h.ctx.repo.db.prepare('SELECT label_enc FROM contact_directory').all() as { label_enc: Buffer | null }[];
    expect(raw.some((r) => r.label_enc?.includes(Buffer.from('Ahmet')))).toBe(false);
  });

  it('refuses to record a call with a blocked contact and hides the record button', async () => {
    class CallWa extends NullWa {
      override readonly calls: CallService;
      constructor(ctx: Harness['ctx']) {
        super();
        this.calls = new CallService(ctx, () => ({ call: async () => true, audioIn() {}, videoIn() {} }) as unknown as CallBridge);
      }
    }
    let wa!: CallWa;
    const h2 = await makeHarness({}, { wa: (ctx) => (wa = new CallWa(ctx)) as WaController });
    try {
      await h2.client().signup();
      const call = (over: Partial<RawCall>): RawCall => ({
        id: 'C1', state: 6, outgoing: false, isVideo: false, isGroup: false, peer: AHMET_LID, peerAlt: AHMET, group: null, peerBusy: false, failedReason: null,
        logResult: null, everConnected: true, userEnded: false, selfVideo: false, peerVideo: false, removed: false, ...over,
      });
      wa.calls.onCall(call({}));
      expect(wa.calls.current()?.recordingBlocked).toBe(false);
      h2.ctx.blocks.replace(['905559990001']);
      expect(wa.calls.current()?.recordingBlocked).toBe(true);
      await expect(wa.calls.startRecording('C1')).rejects.toMatchObject({ code: 'conflict' });
      await expect(wa.calls.startRecording('C1', true)).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      await h2.close();
    }
  });
});

describe('block list routes of a worker', () => {
  let h: Harness;
  const internal = (method: string, url: string, body?: unknown) =>
    h.client().req(method, url, body, { origin: null, headers: { 'x-wal-internal': TOKEN, 'x-wal-scope': 'internal' } });

  beforeEach(async () => {
    h = await makeHarness({ SETUP_TOKEN: '', INTERNAL_TOKEN: TOKEN });
  });
  afterEach(async () => {
    await h.close();
  });

  it('needs the gateway scope, validates numbers and replaces the list', async () => {
    const plain = h.client({ 'x-wal-internal': TOKEN });
    expect((await plain.req('GET', '/internal/blocking', undefined, { origin: null })).status).toBe(403);
    expect((await plain.req('PUT', '/internal/blocking', { phones: ['905559990001'] }, { origin: null })).status).toBe(403);
    expect((await internal('PUT', '/internal/blocking', { phones: ['nope'] })).status).toBe(400);
    expect((await internal('PUT', '/internal/blocking', { phones: ['+90 555 999 00 01', '905559990001'] })).body).toEqual({ ok: true, count: 1 });
    const got = (await internal('GET', '/internal/blocking')).body as { contacts: { phone: string; blocked: boolean }[] };
    expect(got.contacts).toEqual([{ phone: '905559990001', label: null, blocked: true }]);
    expect((await internal('PUT', '/internal/blocking', { phones: [] })).body).toEqual({ ok: true, count: 0 });
    expect(h.ctx.blocks.active).toBe(false);
  });
});
