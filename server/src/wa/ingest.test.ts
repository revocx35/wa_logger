import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataReader, PRIVKEY_AAD, unwrapPrivateKey } from '../crypto/keyring.js';
import { derivePasswordKeys } from '../crypto/password.js';
import { F } from '../db/repo.js';
import { PASSWORD, makeHarness, type Harness } from '../testutil/harness.js';
import { Ingest, type WaApi } from './ingest.js';
import type { RawMsg } from './mapper.js';

const THUMB = '/9j/' + 'B'.repeat(400);
const CHAT = '905551112233@c.us';
const GROUP = '120363000000@g.us';

function rid(msgId: string, remote = CHAT, fromMe = false, participant?: string) {
  return { fromMe, remote, id: msgId, participant, _serialized: `${fromMe}_${remote}_${msgId}${participant ? `_${participant}` : ''}` };
}
const text = (msgId: string, body: string, over: RawMsg = {}): RawMsg => ({
  id: rid(msgId),
  type: 'chat',
  body,
  t: 1_700_000_000,
  from: CHAT,
  ack: 1,
  notifyName: 'Ali',
  ...over,
});

describe('ingest', () => {
  let h: Harness;
  let ingest: Ingest;
  let reader: DataReader;
  let enqueued: string[];
  const api: WaApi = {
    getChat: async (id) => ({ name: id === GROUP ? 'Family' : 'Ali Veli', timestamp: 1_700_000_000_000, archived: false, pinned: false, muted: false }),
    getContact: async (id) => ({ name: id.startsWith('9055') ? 'Ali Veli' : null, pushname: 'ali', isMe: false, isBusiness: false }),
  };

  beforeEach(async () => {
    h = await makeHarness();
    await h.client().signup();
    const owner = h.ctx.repo.getOwner()!;
    const { kek } = await derivePasswordKeys(PASSWORD, owner.pw_salt, h.ctx.config.scryptLogN);
    reader = DataReader.fromPkcs8(h.ctx.repo, unwrapPrivateKey(kek, owner.privkey_pw, PRIVKEY_AAD.password));
    enqueued = [];
    ingest = new Ingest(h.ctx, api, { enqueue: (id) => enqueued.push(id) });
  });
  afterEach(async () => {
    await h.close();
  });

  const bodyOf = (id: string) => reader.tryText(...F.body(id), h.ctx.repo.getMessage(id)?.body_enc);

  it('stores a new message encrypted, creates the chat and contact, emits an event', async () => {
    const events: string[] = [];
    h.ctx.events.subscribe((e) => events.push(e.type));
    const id = await ingest.message(text('A1', 'secret hello'), 'live');
    const row = h.ctx.repo.getMessage(id!)!;
    expect(row.chat_id).toBe(CHAT);
    expect(row.body_enc!.includes(Buffer.from('secret hello'))).toBe(false);
    expect(bodyOf(id!)).toBe('secret hello');
    expect(row.source).toBe('live');
    const chat = h.ctx.repo.getChat(CHAT)!;
    expect(reader.tryText(...F.chatName(CHAT), chat.name_enc)).toBe('Ali Veli');
    expect(chat.last_ts).toBe(1_700_000_000_000);
    const contact = h.ctx.repo.getContact(CHAT)!;
    expect(reader.tryText(...F.contactName(CHAT), contact.name_enc)).toBe('Ali Veli');
    expect(events).toContain('message');
    // idempotent
    await ingest.message(text('A1', 'secret hello'), 'live');
    expect(h.ctx.repo.listMessagesBefore(CHAT, null, 10)).toHaveLength(1);
  });

  it('queues media downloads, respects the size cap, history setting and view-once', async () => {
    await ingest.message({ ...text('M1', ''), type: 'image', body: THUMB, caption: 'pic', directPath: '/p', size: 1000, mimetype: 'image/jpeg' }, 'live');
    expect(enqueued).toEqual(['false_905551112233@c.us_M1']);
    const r1 = h.ctx.repo.getMessage('false_905551112233@c.us_M1')!;
    expect(r1.media_status).toBe('pending');
    expect(bodyOf(r1.id)).toBe('pic');
    expect(reader.decrypt(...F.thumb(r1.id), r1.thumb_enc)!.toString('base64')).toBe(THUMB);

    await ingest.message({ ...text('M2', ''), type: 'video', directPath: '/p', size: 500 * 1024 * 1024 }, 'live');
    expect(h.ctx.repo.getMessage('false_905551112233@c.us_M2')!.media_status).toBe('too_large');

    h.ctx.settings.update({ downloadHistoryMedia: false });
    await ingest.message({ ...text('M3', ''), type: 'image', directPath: '/p', size: 10 }, 'history');
    expect(h.ctx.repo.getMessage('false_905551112233@c.us_M3')!.media_status).toBe('skipped');

    await ingest.message({ ...text('M4', ''), type: 'image', isViewOnce: true, directPath: '/p', body: THUMB }, 'live');
    const vo = h.ctx.repo.getMessage('false_905551112233@c.us_M4')!;
    expect(vo.media_status).toBe('view_once');
    expect(vo.thumb_enc).toBeNull();
    expect(vo.type).toBe('view_once');
    expect(enqueued).toHaveLength(1);
  });

  it('keeps deleted-for-everyone messages and flags them', async () => {
    const id = (await ingest.message(text('D1', 'will be deleted'), 'live'))!;
    await ingest.revoke({ ...text('D1', ''), type: 'revoked', subtype: 'sender' }, null);
    const row = h.ctx.repo.getMessage(id)!;
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(row.deleted_by).toBe('sender');
    expect(bodyOf(id)).toBe('will be deleted');
    expect(row.type).toBe('chat');
    // reconcile seeing the revoked version does not wipe anything
    await ingest.message({ ...text('D1', ''), type: 'revoked', subtype: 'sender' }, 'live');
    expect(bodyOf(id)).toBe('will be deleted');
  });

  it('recovers the original from `before` when the message was never logged', async () => {
    await ingest.revoke({ ...text('D2', ''), type: 'revoked', subtype: 'sender' }, text('D2', 'original text'));
    const id = 'false_905551112233@c.us_D2';
    const row = h.ctx.repo.getMessage(id)!;
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(bodyOf(id)).toBe('original text');
  });

  it('stores a stub when a never-logged message is revoked without data', async () => {
    await ingest.revoke({ ...text('D3', ''), type: 'revoked', subtype: 'admin' }, null);
    const row = h.ctx.repo.getMessage('false_905551112233@c.us_D3')!;
    expect(row.type).toBe('revoked');
    expect(row.deleted_by).toBe('admin');
    expect(row.body_enc).toBeNull();
    // a later history import with the original content fills the stub, keeping the deletion flag
    await ingest.message(text('D3', 'late original'), 'history');
    const filled = h.ctx.repo.getMessage('false_905551112233@c.us_D3')!;
    expect(bodyOf(filled.id)).toBe('late original');
    expect(filled.deleted_at).toBe(row.deleted_at);
  });

  it('records edits with history, once per edit key', async () => {
    const id = (await ingest.message(text('E1', 'first'), 'live'))!;
    const edited = text('E1', 'second', { latestEditMsgKey: { _serialized: 'EK1' }, latestEditSenderTimestampMs: 1_700_000_050_000 });
    await ingest.edit(edited, 'second', 'first');
    await ingest.edit(edited, 'second', 'first');
    await ingest.message(edited, 'live'); // reconcile sees the same edit
    expect(bodyOf(id)).toBe('second');
    const edits = h.ctx.repo.listEdits(id);
    expect(edits).toHaveLength(1);
    expect(reader.tryText(...F.body(id), edits[0]!.body_enc)).toBe('first');
    expect(h.ctx.repo.getMessage(id)!.edited_at).toBe(1_700_000_050_000);
    // an edit missed live and only seen by reconcile
    await ingest.message(text('E1', 'third', { latestEditMsgKey: { _serialized: 'EK2' } }), 'live');
    expect(bodyOf(id)).toBe('third');
    expect(h.ctx.repo.listEdits(id)).toHaveLength(2);
  });

  it('ignores thumbnail-only body changes on media', async () => {
    const raw = { ...text('E2', ''), type: 'image', body: THUMB, caption: 'cap', directPath: '/p' };
    const id = (await ingest.message(raw, 'live'))!;
    await ingest.edit(raw, THUMB.replace('B', 'C'), THUMB);
    expect(h.ctx.repo.listEdits(id)).toHaveLength(0);
    expect(bodyOf(id)).toBe('cap');
  });

  it('fills ciphertext placeholders when they decrypt', async () => {
    const id = (await ingest.message({ ...text('C1', ''), type: 'ciphertext' }, 'live'))!;
    expect(h.ctx.repo.getMessage(id)!.type).toBe('ciphertext');
    await ingest.message(text('C1', 'now readable'), 'live');
    expect(h.ctx.repo.getMessage(id)!.type).toBe('chat');
    expect(bodyOf(id)).toBe('now readable');
  });

  it('tracks reactions including removal', async () => {
    const id = (await ingest.message(text('R1', 'react to me'), 'live'))!;
    ingest.reaction({ msgId: { _serialized: id }, senderId: 'x@c.us', reaction: '👍', timestamp: 1_700_000_001 });
    let rs = h.ctx.repo.reactionsFor([id]);
    expect(rs).toHaveLength(1);
    expect(reader.tryText(...F.reaction(id, 'x@c.us'), rs[0]!.emoji_enc)).toBe('👍');
    ingest.reaction({ msgId: { _serialized: id }, senderId: 'x@c.us', reaction: '', timestamp: 1_700_000_002 });
    rs = h.ctx.repo.reactionsFor([id]);
    expect(rs[0]!.removed_at).toBeGreaterThan(0);
  });

  it('marks deleted-for-me and updates acks monotonically', async () => {
    const id = (await ingest.message(text('X1', 'mine', { id: rid('X1', CHAT, true) }), 'live'))!;
    ingest.ack(text('X1', '', { id: rid('X1', CHAT, true) }), 3);
    ingest.ack(text('X1', '', { id: rid('X1', CHAT, true) }), 2);
    expect(h.ctx.repo.getMessage(id)!.ack).toBe(3);
    ingest.revokeMe(text('X1', '', { id: rid('X1', CHAT, true) }));
    const row = h.ctx.repo.getMessage(id)!;
    expect(row.deleted_for_me_at).toBeGreaterThan(0);
    expect(bodyOf(id)).toBe('mine');
    expect(row.from_me).toBe(1);
    expect(row.sender_id).toBeNull();
  });

  it('stores group notifications as system messages', async () => {
    await ingest.groupNotification({
      id: rid('N1', GROUP, false, 'x@c.us'),
      type: 'add',
      body: '',
      timestamp: 1_700_000_100,
      chatId: GROUP,
      author: 'x@c.us',
      recipientIds: ['y@c.us'],
    });
    const rows = h.ctx.repo.listMessagesBefore(GROUP, null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('system');
    expect(reader.tryJson<{ system: { subtype: string } }>(...F.meta(rows[0]!.id), rows[0]!.meta_enc)?.system.subtype).toBe('add');
    expect(reader.tryText(...F.chatName(GROUP), h.ctx.repo.getChat(GROUP)!.name_enc)).toBe('Family');
  });

  it('skips status updates when disabled', async () => {
    h.ctx.settings.update({ logStatus: false });
    const r = await ingest.message(
      { id: rid('S1', 'status@broadcast', false, 'p@c.us'), type: 'chat', body: 'story', t: 1, author: 'p@c.us', isStatusV3: true },
      'live',
    );
    expect(r).toBeNull();
    h.ctx.settings.update({ logStatus: true });
    await ingest.message({ id: rid('S2', 'status@broadcast', false, 'p@c.us'), type: 'chat', body: 'story', t: 1, author: 'p@c.us', isStatusV3: true }, 'live');
    expect(reader.tryText(...F.chatName('status@broadcast'), h.ctx.repo.getChat('status@broadcast')!.name_enc)).toBe('Status updates');
  });

  it('marks removed and archived chats', async () => {
    await ingest.message(text('Z1', 'x'), 'live');
    ingest.chatArchived(CHAT, true);
    expect(h.ctx.repo.getChat(CHAT)!.archived).toBe(1);
    ingest.chatRemoved(CHAT);
    expect(h.ctx.repo.getChat(CHAT)!.removed_at).toBeGreaterThan(0);
    expect(h.ctx.repo.listMessagesBefore(CHAT, null, 10)).toHaveLength(1);
  });
});
