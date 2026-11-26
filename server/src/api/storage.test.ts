import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSummary, MessagePage, Settings } from '../../../shared/api.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { RetentionService } from '../retention.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import { beginMediaFile, finishMediaFile } from '../wa/media.js';
import type { RawMsg } from '../wa/mapper.js';

const CHAT = '905551112233@c.us';
const DAY = 86_400_000;
const id = (m: string) => `false_${CHAT}_${m}`;

const text = (msgId: string, body: string, tMs: number, over: RawMsg = {}): RawMsg => ({
  id: { fromMe: false, remote: CHAT, id: msgId, _serialized: id(msgId) },
  type: 'chat',
  body,
  t: Math.floor(tMs / 1000),
  from: CHAT,
  ack: 1,
  ...over,
});

const api: WaApi = {
  getChat: async () => ({ name: 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
};

async function attachMedia(h: Harness, msgId: string, type: string): Promise<string> {
  const f = await beginMediaFile(h.ctx);
  await f.writer.write(Buffer.from('fake media bytes'));
  const { mediaId } = await finishMediaFile(h.ctx, f, 'message', 'image/jpeg', null);
  h.ctx.repo.updateMessage(id(msgId), { type, media_id: mediaId, media_status: 'downloaded' });
  return path.join(h.ctx.config.mediaDir, h.ctx.repo.getMedia(mediaId)!.path);
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe('storage controls', () => {
  let h: Harness;
  let c: TestClient;
  let ingest: Ingest;
  const now = Date.now();

  beforeEach(async () => {
    h = await makeHarness();
    c = h.client();
    await c.signup();
    ingest = new Ingest(h.ctx, api, { enqueue: () => undefined });
    await ingest.message(text('OLD', 'old message', now - 40 * DAY), 'live');
    await ingest.message(text('MID', 'middle message', now - 10 * DAY), 'live');
    await ingest.message(text('NEW', 'new message', now - 1 * DAY), 'live');
  });
  afterEach(async () => {
    await h.close();
  });

  it('settings: retention defaults to forever and is validated', async () => {
    const s = (await c.req('GET', '/api/settings')).body as Settings;
    expect(s.messageRetentionDays).toBe(0);
    expect(s.mediaRetentionDays).toBe(0);
    expect((await c.req('PUT', '/api/settings', { messageRetentionDays: -1 })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings', { mediaRetentionDays: 3651 })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings', { mediaRetentionDays: 1.5 })).status).toBe(400);
    const r = await c.req('PUT', '/api/settings', { messageRetentionDays: 30, mediaRetentionDays: 7 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ messageRetentionDays: 30, mediaRetentionDays: 7 });
  });

  it('deletes single messages with their media; history sync does not log them again', async () => {
    const file = await attachMedia(h, 'MID', 'image');
    expect(await exists(file)).toBe(true);
    const events: unknown[] = [];
    h.ctx.events.subscribe((e) => events.push(e));

    const r = await c.req('POST', '/api/messages/delete', { ids: [id('MID'), id('MISSING')] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 1 });
    expect(await exists(file)).toBe(false);
    expect((await c.req('GET', `/api/messages/${encodeURIComponent(id('MID'))}`)).status).toBe(404);
    expect(events).toContainEqual({ type: 'message_update', chatId: CHAT, messageId: id('MID'), reason: 'deleted' });
    const page = (await c.req('GET', `/api/chats/${CHAT}/messages`)).body as MessagePage;
    expect(page.messages.map((m) => m.id)).toEqual([id('OLD'), id('NEW')]);
    const chat = ((await c.req('GET', '/api/chats')).body as ChatSummary[]).find((x) => x.id === CHAT)!;
    expect(chat.messageCount).toBe(2);

    // History sync / reconcile / a late edit or revoke bring the same message again: it stays deleted.
    await ingest.message(text('MID', 'middle message', now - 10 * DAY), 'history');
    await ingest.edit(text('MID', 'edited', now - 10 * DAY, { latestEditMsgKey: { _serialized: 'EK' } }), 'edited', 'middle message');
    await ingest.revoke({ ...text('MID', '', now - 10 * DAY), type: 'revoked', subtype: 'sender' }, null);
    expect(h.ctx.repo.getMessage(id('MID'))).toBeUndefined();
    // A message never deleted is logged as usual.
    await ingest.message(text('FRESH', 'fresh', now), 'live');
    expect(h.ctx.repo.getMessage(id('FRESH'))).toBeDefined();
  });

  it('validates the delete request and needs a session and CSRF token', async () => {
    expect((await c.req('POST', '/api/messages/delete', { ids: [] })).status).toBe(400);
    expect((await c.req('POST', '/api/messages/delete', { ids: Array.from({ length: 501 }, (_, i) => `x_${i}`) })).status).toBe(400);
    expect((await c.req('POST', '/api/messages/delete', { ids: ['a b'] })).status).toBe(400);
    expect((await c.req('POST', '/api/messages/delete', { ids: [id('OLD')], extra: 1 })).status).toBe(400);
    expect((await c.req('POST', '/api/messages/delete', { ids: [id('OLD')] }, { csrf: null })).status).toBe(403);
    const anon = h.client();
    expect((await anon.req('POST', '/api/messages/delete', { ids: [id('OLD')] })).status).toBe(401);
    expect(h.ctx.repo.getMessage(id('OLD'))).toBeDefined();
  });

  it('message retention deletes old messages and keeps them out of history sync', async () => {
    const oldFile = await attachMedia(h, 'OLD', 'video');
    const svc = new RetentionService(h.ctx);
    expect(await svc.sweep(now)).toEqual({ messages: 0, media: 0 });

    h.ctx.settings.update({ messageRetentionDays: 30 });
    expect(await svc.sweep(now)).toEqual({ messages: 1, media: 0 });
    expect(h.ctx.repo.getMessage(id('OLD'))).toBeUndefined();
    expect(h.ctx.repo.getMessage(id('MID'))).toBeDefined();
    expect(await exists(oldFile)).toBe(false);

    await ingest.message(text('OLD', 'old message', now - 40 * DAY), 'history');
    expect(h.ctx.repo.getMessage(id('OLD'))).toBeUndefined();
    // Set back to "forever": old history is logged again (no tombstone for retention).
    h.ctx.settings.update({ messageRetentionDays: 0 });
    await ingest.message(text('OLD', 'old message', now - 40 * DAY), 'history');
    expect(h.ctx.repo.getMessage(id('OLD'))).toBeDefined();
  });

  it('photo/video retention removes only the files of old photos and videos', async () => {
    const oldImg = await attachMedia(h, 'OLD', 'image');
    const midVid = await attachMedia(h, 'MID', 'video');
    const newImg = await attachMedia(h, 'NEW', 'image');
    await ingest.message(text('DOC', 'a document', now - 40 * DAY), 'live');
    const doc = await attachMedia(h, 'DOC', 'document');

    h.ctx.settings.update({ mediaRetentionDays: 7 });
    const svc = new RetentionService(h.ctx);
    expect(await svc.sweep(now)).toEqual({ messages: 0, media: 2 });
    for (const f of [oldImg, midVid]) expect(await exists(f)).toBe(false);
    for (const f of [newImg, doc]) expect(await exists(f)).toBe(true);

    const old = (await c.req('GET', `/api/messages/${encodeURIComponent(id('OLD'))}`)).body;
    expect(old.text).toBe('old message');
    expect(old.media).toMatchObject({ status: 'expired', url: null });
    // Not retryable, and an old photo seen again is not downloaded.
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(id('OLD'))}/media/retry`)).status).toBe(409);
    const queued: string[] = [];
    const ing2 = new Ingest(h.ctx, api, { enqueue: (m) => queued.push(m) });
    const media = { type: 'image', mimetype: 'image/jpeg', directPath: '/x', mediaKey: 'k', size: 10 } as RawMsg;
    await ing2.message(text('OLDPIC', '', now - 20 * DAY, media), 'history');
    await ing2.message(text('NEWPIC', '', now - 1 * DAY, media), 'history');
    expect(h.ctx.repo.getMessage(id('OLDPIC'))?.media_status).toBe('expired');
    expect(h.ctx.repo.getMessage(id('NEWPIC'))?.media_status).toBe('pending');
    expect(queued).toEqual([id('NEWPIC')]);
  });

  it('a wipe forgets deleted ids', async () => {
    await c.req('POST', '/api/messages/delete', { ids: [id('NEW')] });
    expect(h.ctx.repo.isMessageRemoved(id('NEW'))).toBe(true);
    h.ctx.repo.wipeLoggedData();
    expect(h.ctx.repo.isMessageRemoved(id('NEW'))).toBe(false);
  });
});
