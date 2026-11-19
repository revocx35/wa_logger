import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHarness, type Harness } from '../testutil/harness.js';
import type { MediaRef } from './mapper.js';
import { MediaQueue, downloadMessageMedia } from './media.js';

/* A stand-in for the WhatsApp Web page: `page.evaluate(fn, ...args)` runs `fn` here against a fake `window`. */

const BYTES = Buffer.from('RIFF....WEBPVP8 fake sticker bytes');
const ID = 'false_120363000000@g.us_AC01_111@lid';

interface FakeMsg {
  type: string;
  isViewOnce?: boolean;
  mediaData?: { mediaStage: string };
  directPath?: string;
  mediaKey?: string;
  encFilehash?: string;
  filehash?: string;
  mediaKeyTimestamp?: number;
  mimetype?: string;
  size?: number;
  downloadMedia: (opts: Record<string, unknown>) => Promise<void>;
}

const ref: MediaRef = {
  directPath: '/v/saved',
  mediaKey: 'S0VZ',
  encFilehash: 'RU5D',
  filehash: null,
  mediaKeyTimestamp: 1,
  type: 'sticker',
  mimetype: 'image/webp',
  filename: null,
  size: BYTES.length,
};

class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((b) => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString('base64')}`;
      this.onload?.();
    });
  }
}

function fakePage(msgs: Map<string, FakeMsg>, fetchCdn: (args: Record<string, unknown>) => Promise<ArrayBuffer>) {
  const win = {
    require(name: string) {
      if (name === 'WAWebCollections') {
        return { Msg: { get: (id: string) => msgs.get(id), getMessagesById: async (ids: string[]) => ({ messages: ids.map((i) => msgs.get(i)).filter(Boolean) }) } };
      }
      if (name === 'WAWebDownloadManager') return { downloadManager: { downloadAndMaybeDecrypt: fetchCdn } };
      throw new Error(`unexpected module ${name}`);
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('FileReader', FakeFileReader);
  return { evaluate: (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => Promise.resolve(fn(...args)) } as unknown as Page;
}

const ok = async () => BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.length) as ArrayBuffer;

describe('downloadMessageMedia', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    await h.client().signup();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await h.close();
  });

  const storedBytes = async (mediaId: number) => {
    const m = h.ctx.repo.getMedia(mediaId)!;
    const st = await fs.stat(path.join(h.ctx.config.mediaDir, m.path));
    return { size: m.size, onDisk: st.size };
  };

  it('downloads media WhatsApp Web did not auto-download (stage INIT, untrusted sender) straight from the CDN', async () => {
    const calls: Record<string, unknown>[] = [];
    // Since 2.3000.1054x downloadMedia() is a no-op for untrusted messages: the stage stays INIT.
    const msg: FakeMsg = {
      type: 'sticker',
      mediaData: { mediaStage: 'INIT' },
      directPath: '/v/live',
      mediaKey: 'TElWRQ==',
      encFilehash: 'RU5D',
      mimetype: 'image/webp',
      size: BYTES.length,
      downloadMedia: async (o) => void calls.push(o),
    };
    const fetched: Record<string, unknown>[] = [];
    const page = fakePage(new Map([[ID, msg]]), async (a) => (fetched.push(a), ok()));
    const out = await downloadMessageMedia(h.ctx, page, ID, 1e9, ref);
    expect(out.status).toBe('ok');
    expect(calls[0]).toMatchObject({ isUserInitiated: true, downloadEvenIfExpensive: true });
    // The live model's keys win over the saved ones.
    expect(fetched[0]).toMatchObject({ directPath: '/v/live', mediaKey: 'TElWRQ==', mimetype: 'image/webp', type: 'sticker' });
    if (out.status === 'ok') expect((await storedBytes(out.mediaId)).size).toBe(BYTES.length);
  });

  it('uses the keys saved on arrival when the message was deleted for everyone (re-keyed, not found)', async () => {
    const fetched: Record<string, unknown>[] = [];
    const page = fakePage(new Map(), async (a) => (fetched.push(a), ok()));
    const out = await downloadMessageMedia(h.ctx, page, ID, 1e9, ref);
    expect(out.status).toBe('ok');
    expect(fetched[0]).toMatchObject({ directPath: '/v/saved', mediaKey: 'S0VZ', encFilehash: 'RU5D', mimetype: 'image/webp' });
  });

  it('uses the saved keys when the model is revoked or loses mediaData while waiting, without throwing', async () => {
    const revoked: FakeMsg = { type: 'revoked', downloadMedia: async () => undefined };
    expect((await downloadMessageMedia(h.ctx, fakePage(new Map([[ID, revoked]]), ok), ID, 1e9, ref)).status).toBe('ok');

    // A delete for everyone arriving during downloadMedia(): mediaData and the keys vanish from the model.
    const msg: FakeMsg = {
      type: 'image',
      mediaData: { mediaStage: 'INIT' },
      directPath: '/v/live',
      mediaKey: 'TElWRQ==',
      encFilehash: 'RU5D',
      downloadMedia: async () => {
        msg.mediaData = undefined;
        msg.directPath = undefined;
        msg.mediaKey = undefined;
      },
    };
    const fetched: Record<string, unknown>[] = [];
    const out = await downloadMessageMedia(h.ctx, fakePage(new Map([[ID, msg]]), async (a) => (fetched.push(a), ok())), ID, 1e9, ref);
    expect(out.status).toBe('ok');
    expect(fetched[0]).toMatchObject({ directPath: '/v/saved' });
  });

  it('reports gone, missing and oversized media', async () => {
    expect(await downloadMessageMedia(h.ctx, fakePage(new Map(), ok), ID, 1e9, null)).toEqual({ status: 'unavailable', reason: 'not_found' });
    const gone = async () => {
      throw Object.assign(new Error('404'), { status: 404 });
    };
    expect(await downloadMessageMedia(h.ctx, fakePage(new Map(), gone), ID, 1e9, ref)).toEqual({ status: 'unavailable', reason: 'gone' });
    expect((await downloadMessageMedia(h.ctx, fakePage(new Map(), ok), ID, 5, ref)).status).toBe('too_large');
    const reup: FakeMsg = { type: 'video', mediaData: { mediaStage: 'REUPLOADING' }, directPath: '/x', downloadMedia: async () => undefined };
    expect(await downloadMessageMedia(h.ctx, fakePage(new Map([[ID, reup]]), ok), ID, 1e9, ref)).toEqual({ status: 'retry', reason: 'reuploading' });
  });

  it('MediaQueue downloads a quickly deleted message with the remembered keys', async () => {
    const page = fakePage(new Map(), ok);
    const now = Date.now();
    h.ctx.repo.insertMessage({
      id: ID,
      chat_id: '120363000000@g.us',
      sender_id: '111@lid',
      from_me: 0,
      ts: now,
      type: 'sticker',
      body_enc: null,
      meta_enc: null,
      thumb_enc: null,
      quoted_id: null,
      media_id: null,
      media_status: 'pending',
      media_attempts: 0,
      media_size: BYTES.length,
      media_w: null,
      media_h: null,
      media_duration: null,
      is_view_once: 0,
      is_forwarded: 0,
      is_status: 0,
      ephemeral_sec: null,
      ack: 1,
      deleted_at: now,
      deleted_by: 'sender',
      deleted_for_me_at: null,
      edited_at: null,
      last_edit_key: null,
      source: 'live',
      captured_at: now,
      updated_at: now,
    });
    const q = new MediaQueue(h.ctx, () => page);
    q.remember(ID, ref);
    expect(q.hasRef(ID)).toBe(true);
    q.enqueue(ID, 'live');
    q.resume();
    await vi.waitFor(() => expect(h.ctx.repo.getMessage(ID)!.media_status).toBe('downloaded'), { timeout: 5000 });
    expect(q.hasRef(ID)).toBe(false);
    q.stop();
  });
});
