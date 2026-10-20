import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallRecording } from '../../../shared/api.js';
import { NullWa, type WaController } from '../context.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import type { CallBridge, RawCall } from '../wa/callbridge.js';
import { CallService } from '../wa/calls.js';
import { Ingest, type WaApi } from '../wa/ingest.js';
import type { RawMsg } from '../wa/mapper.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const CHAT = '905551112233@c.us';
const waApi: WaApi = {
  getChat: async () => ({ name: 'Ali Veli', timestamp: null, archived: false, pinned: false, muted: false }),
  getContact: async () => ({ name: 'Ali Veli', pushname: 'ali', isMe: false, isBusiness: false }),
};
const msg = (id: string): RawMsg => ({ id: { fromMe: false, remote: CHAT, id, _serialized: `false_${CHAT}_${id}` }, type: 'chat', body: 'hi', t: 1_700_000_000, from: CHAT });
const raw = (over: Partial<RawCall>): RawCall => ({
  id: 'C1', state: 3, outgoing: false, isVideo: false, isGroup: false, peer: CHAT, peerAlt: null, group: null, peerBusy: false, failedReason: null,
  logResult: null, everConnected: false, userEnded: false, selfVideo: false, peerVideo: false, removed: false, ...over,
});

class FakeBridge {
  ops: string[] = [];
  async call(op: string): Promise<unknown> {
    this.ops.push(op);
    return true;
  }
  audioIn(): void {}
  videoIn(): void {}
}
class CallWa extends NullWa {
  override readonly calls: CallService;
  constructor(ctx: Harness['ctx']) {
    super();
    this.calls = new CallService(ctx, () => new FakeBridge() as unknown as CallBridge);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tone = (samples: number, from: number): Buffer => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (from + i)) / 16000)), i * 2);
  return b;
};

function ffprobe(file: string): Promise<{ streams: { codec_name: string; width?: number; height?: number }[]; format: { duration: string } }> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error('ffprobe failed'))));
  });
}

/** H.264 access units (Annex B, with AUDs) of a short test picture, as the call bridge would deliver them (header + AU). */
async function testFrames(): Promise<Buffer[]> {
  const out = await new Promise<Buffer>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=15:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-x264-params', 'aud=1', '-f', 'h264', 'pipe:1']);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('close', (c) => (c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg failed'))));
  });
  const starts: number[] = [];
  for (let i = 0; i + 4 < out.length; i++) {
    if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 1 && (out[i + 3]! & 0x1f) === 9) starts.push(out[i - 1] === 0 ? i - 1 : i);
  }
  return starts.map((s, k) => {
    const au = out.subarray(s, starts[k + 1] ?? out.length);
    let key = 0;
    for (let i = 0; i + 3 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3]! & 0x1f) === 5) key = 1;
    const h = Buffer.alloc(12);
    h[0] = 1;
    h[1] = key;
    h.writeUInt16LE(320, 4);
    h.writeUInt16LE(240, 6);
    return Buffer.concat([h, au]);
  });
}

describe.skipIf(!HAS_FFMPEG)('call recording', () => {
  let h: Harness;
  let c: TestClient;
  let wa: CallWa;

  beforeEach(async () => {
    h = await makeHarness({}, { wa: (ctx) => (wa = new CallWa(ctx)) as WaController });
    c = h.client();
    await c.signup();
    await new Ingest(h.ctx, waApi, { enqueue: () => undefined }).message(msg('M1'), 'live');
  });
  afterEach(async () => {
    await h.close();
  });

  const list = async () => (await c.req('GET', '/api/call-recordings')).body as { items: CallRecording[]; nextBefore: number | null };
  async function ready(): Promise<CallRecording> {
    for (let i = 0; i < 100; i++) {
      const it = (await list()).items[0];
      if (it && it.status !== 'recording' && it.status !== 'processing') return it;
      await sleep(100);
    }
    throw new Error('recording did not finish');
  }
  async function download(r: CallRecording): Promise<string> {
    const res = await h.app.inject({ method: 'GET', url: r.url!, headers: { cookie: c.cookie } });
    expect(res.statusCode).toBe(200);
    const file = path.join(os.tmpdir(), `walrec-${r.id}-${Date.now()}.mp4`);
    await fs.writeFile(file, res.rawPayload);
    return file;
  }

  it('needs a connected call, records on request and serves an encrypted MP4', async () => {
    wa.calls.onCall(raw({ state: 3 }));
    expect((await c.req('POST', '/api/calls/C1/recording', { on: true })).status).toBe(409);
    wa.calls.onCall(raw({ state: 6, everConnected: true }));

    const on = await c.req('POST', '/api/calls/C1/recording', { on: true });
    expect(on.status).toBe(200);
    expect(on.body.recording).toBe(true);
    expect((await c.req('GET', '/api/calls/current')).body.call.recording).toBe(true);
    expect((await list()).items[0]).toMatchObject({ status: 'recording', url: null, name: 'Ali Veli', direction: 'incoming' });

    let at = 0;
    for (let i = 0; i < 50; i++) {
      wa.calls.onPageAudio(tone(640, at)); // the other side
      at += 640;
      await sleep(40);
    }
    const off = await c.req('POST', '/api/calls/C1/recording', { on: false });
    expect(off.status).toBe(200);
    expect(off.body.recording).toBe(false);

    const rec = await ready();
    expect(rec).toMatchObject({ status: 'ready', video: false, auto: false, chatId: CHAT });
    expect(rec.url).toMatch(/^\/api\/media\/\d+$/);
    const file = await download(rec);
    const info = await ffprobe(file);
    expect(info.streams.map((s) => s.codec_name)).toEqual(['aac']);
    expect(Number(info.format.duration)).toBeGreaterThan(1.4);
    expect(Number(info.format.duration)).toBeLessThan(3.5);
    // The stored file is encrypted, not an MP4.
    const media = h.ctx.repo.getMedia(Number(rec.url!.split('/').pop()))!;
    const stored = await fs.readFile(path.join(h.ctx.config.mediaDir, media.path));
    expect(stored.subarray(0, 4).toString()).toBe('WAL1');
    expect(stored.includes(Buffer.from('ftyp'))).toBe(false);
    await fs.rm(file);
  }, 30_000);

  it('records automatically when the setting is on, and the owner can delete it', async () => {
    expect((await c.req('PUT', '/api/settings', { recordCalls: true })).status).toBe(200);
    wa.calls.onCall(raw({ state: 3 }));
    wa.calls.onCall(raw({ state: 6, everConnected: true }));
    await sleep(100);
    expect(wa.calls.current()!.recording).toBe(true);
    for (let i = 0; i < 20; i++) {
      wa.calls.onPageAudio(tone(640, i * 640));
      await sleep(40);
    }
    wa.calls.onCall(raw({ state: 13, everConnected: true, userEnded: true }));
    const rec = await ready();
    expect(rec).toMatchObject({ status: 'ready', auto: true });

    const id = Number(rec.url!.split('/').pop());
    const media = h.ctx.repo.getMedia(id)!;
    expect((await c.req('DELETE', `/api/call-recordings/${rec.id}`)).status).toBe(200);
    expect((await list()).items).toEqual([]);
    expect(h.ctx.repo.getMedia(id)).toBeUndefined();
    await expect(fs.stat(path.join(h.ctx.config.mediaDir, media.path))).rejects.toThrow();
    expect((await c.req('DELETE', `/api/call-recordings/${rec.id}`)).status).toBe(404);
  }, 30_000);

  it('does not record unless asked', async () => {
    wa.calls.onCall(raw({ state: 3 }));
    wa.calls.onCall(raw({ state: 6, everConnected: true }));
    await sleep(50);
    expect(wa.calls.current()!.recording).toBe(false);
    expect((await list()).items).toEqual([]);
  });

  it('records the other side\'s picture in a video call', async () => {
    const frames = await testFrames();
    expect(frames.length).toBeGreaterThan(30);
    wa.calls.onCall(raw({ state: 3, isVideo: true }));
    wa.calls.onCall(raw({ state: 6, isVideo: true, peerVideo: true, everConnected: true }));
    expect((await c.req('POST', '/api/calls/C1/recording', { on: true })).status).toBe(200);
    let at = 0;
    for (let i = 0; i < frames.length; i++) {
      wa.calls.onPageVideo(frames[i]!);
      if (i % 2 === 0) {
        wa.calls.onPageAudio(tone(640, at));
        at += 640;
      }
      await sleep(66);
    }
    expect((await c.req('POST', '/api/calls/C1/recording', { on: false })).status).toBe(200);
    const rec = await ready();
    expect(rec).toMatchObject({ status: 'ready', video: true });
    const file = await download(rec);
    const info = await ffprobe(file);
    const v = info.streams.find((s) => s.codec_name === 'h264')!;
    expect(v).toMatchObject({ width: 320, height: 240 });
    expect(info.streams.some((s) => s.codec_name === 'aac')).toBe(true);
    expect(Number(info.format.duration)).toBeGreaterThan(2.5);
    await fs.rm(file);
  }, 40_000);

  it('marks recordings that were still being written when the app stopped as failed', async () => {
    const id = h.ctx.repo.insertRecording({ call_id: 'X', chat_id: CHAT, direction: 'outgoing', video: false, auto: false, started_at: 1 });
    new CallService(h.ctx, () => null);
    expect(h.ctx.repo.getRecording(id)!.status).toBe('failed');
  });
});
