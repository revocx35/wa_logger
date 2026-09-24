import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataReader, PRIVKEY_AAD, unwrapPrivateKey } from '../crypto/keyring.js';
import { derivePasswordKeys } from '../crypto/password.js';
import { F } from '../db/repo.js';
import { PASSWORD, makeHarness, type Harness } from '../testutil/harness.js';
import { WaService } from './client.js';

/*
 * Drives WaService's real event wiring with a fake whatsapp-web.js client: verifies that library
 * events (with the argument shapes of whatsapp-web.js 1.34.7) end up in the encrypted log.
 */

const CHAT = '905551112233@c.us';
const GROUP = '120363000000000001@g.us';

function rid(id: string, remote = CHAT, fromMe = false, participant?: string) {
  return { fromMe, remote, id, participant, _serialized: `${fromMe}_${remote}_${id}${participant ? `_${participant}` : ''}` };
}

class FakeClient extends EventEmitter {
  info = { wid: { _serialized: '905550000001@c.us' }, pushname: 'Me' };
  async getChatById(id: string) {
    return { id: { _serialized: id }, name: id === GROUP ? 'Group' : 'Ali', timestamp: 1_700_000_000, archived: false, pinned: false, isMuted: false };
  }
  async getContactById() {
    return { name: 'Ali', pushname: 'ali', isMe: false, isBusiness: false };
  }
}

describe('WaService event wiring', () => {
  let h: Harness;
  let svc: WaService;
  let fake: FakeClient;
  let reader: DataReader;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priv = () => svc as any;
  const flush = async () => {
    await priv().chain;
    await new Promise((r) => setTimeout(r, 10));
    await priv().chain;
  };

  beforeEach(async () => {
    h = await makeHarness();
    await h.client().signup();
    const owner = h.ctx.repo.getOwner()!;
    const { kek } = await derivePasswordKeys(PASSWORD, owner.pw_salt, h.ctx.config.scryptLogN);
    reader = DataReader.fromPkcs8(h.ctx.repo, unwrapPrivateKey(kek, owner.privkey_pw, PRIVKEY_AAD.password));
    svc = new WaService(h.ctx);
    fake = new FakeClient();
    priv().client = fake;
    priv().attach(fake, priv().generation);
  });
  afterEach(async () => {
    svc.media.stop();
    await h.close();
  });

  const body = (id: string) => reader.tryText(...F.body(id), h.ctx.repo.getMessage(id)?.body_enc);

  it('maps connection events to states', () => {
    fake.emit('qr', 'qr-data');
    expect(svc.status().state).toBe('qr');
    fake.emit('authenticated');
    expect(svc.status().state).toBe('authenticating');
    fake.emit('disconnected', 'LOGOUT');
    expect(svc.status().state).toBe('disconnected');
    expect(svc.status().detail).toMatch(/unlinked/);
  });

  it('logs message_create, then keeps it through message_revoke_everyone (before undefined)', async () => {
    fake.emit('message_create', { _data: { id: rid('M1'), type: 'chat', body: 'secret', t: 1_700_000_001, from: CHAT } });
    fake.emit('message_revoke_everyone', { _data: { id: rid('M1'), type: 'revoked', subtype: 'sender', t: 1_700_000_001, from: CHAT } }, undefined);
    await flush();
    const row = h.ctx.repo.getMessage(`false_${CHAT}_M1`)!;
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(body(row.id)).toBe('secret');
  });

  it('applies message_edit with (message, newBody, prevBody) and records history', async () => {
    fake.emit('message_create', { _data: { id: rid('E1'), type: 'chat', body: 'v1', t: 1_700_000_002, from: CHAT } });
    fake.emit(
      'message_edit',
      { _data: { id: rid('E1'), type: 'chat', body: 'v2', t: 1_700_000_002, from: CHAT, latestEditMsgKey: { _serialized: 'K1' } } },
      'v2',
      'v1',
    );
    await flush();
    expect(body(`false_${CHAT}_E1`)).toBe('v2');
    expect(h.ctx.repo.listEdits(`false_${CHAT}_E1`)).toHaveLength(1);
  });

  it('stores group notifications and reactions', async () => {
    fake.emit('group_join', { id: rid('G1', GROUP, false, 'x@c.us'), type: 'add', body: '', timestamp: 1_700_000_003, chatId: GROUP, author: 'x@c.us', recipientIds: ['y@c.us'] });
    fake.emit('message_create', { _data: { id: rid('R1'), type: 'chat', body: 'hi', t: 1_700_000_004, from: CHAT } });
    fake.emit('message_reaction', { msgId: { _serialized: `false_${CHAT}_R1` }, senderId: 'x@c.us', reaction: '🔥', timestamp: 1_700_000_005 });
    fake.emit('message_ack', { _data: { id: rid('R1'), type: 'chat', t: 1_700_000_004 } }, 2);
    fake.emit('chat_archived', { id: { _serialized: CHAT } }, true, false);
    await flush();
    expect(h.ctx.repo.listMessagesBefore(GROUP, null, 5)[0]?.type).toBe('system');
    expect(h.ctx.repo.reactionsFor([`false_${CHAT}_R1`])).toHaveLength(1);
    expect(h.ctx.repo.getMessage(`false_${CHAT}_R1`)!.ack).toBe(2);
    expect(h.ctx.repo.getChat(CHAT)!.archived).toBe(1);
  });

  it('keeps events in order even when an early handler is slow', async () => {
    // ensureChat for a brand-new chat awaits the (fake) client; the revoke must still apply after it.
    fake.getChatById = async (id: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return { id: { _serialized: id }, name: 'Slow', timestamp: 1, archived: false, pinned: false, isMuted: false };
    };
    const other = '905559990000@c.us';
    fake.emit('message_create', { _data: { id: rid('S1', other), type: 'chat', body: 'quick delete', t: 1_700_000_010, from: other } });
    fake.emit('message_revoke_everyone', { _data: { id: rid('S1', other), type: 'revoked', subtype: 'sender', t: 1_700_000_010, from: other } }, undefined);
    await flush();
    const row = h.ctx.repo.getMessage(`false_${other}_S1`)!;
    expect(body(row.id)).toBe('quick delete');
    expect(row.deleted_at).toBeGreaterThan(0);
  });

  it('retries failed media but never view-once', () => {
    h.ctx.repo.upsertChat({ id: CHAT, kind: 'user', now: 1 });
    const base = {
      chat_id: CHAT, sender_id: CHAT, from_me: 0, ts: 1, type: 'image', body_enc: null, meta_enc: null, thumb_enc: null, quoted_id: null,
      media_id: null, media_attempts: 4, media_size: 10, media_w: null, media_h: null, media_duration: null, is_forwarded: 0, is_status: 0,
      ack: 1, deleted_at: null, deleted_by: null, deleted_for_me_at: null, edited_at: null, last_edit_key: null, source: 'live', captured_at: 1, updated_at: 1,
    };
    h.ctx.repo.insertMessage({ ...base, id: 'fail1', media_status: 'failed', is_view_once: 0 });
    h.ctx.repo.insertMessage({ ...base, id: 'vo1', media_status: 'view_once', is_view_once: 1 });
    expect(svc.retryMedia('fail1')).toBe(true);
    expect(h.ctx.repo.getMessage('fail1')!.media_status).toBe('pending');
    expect(svc.retryMedia('vo1')).toBe(false);
  });
});
