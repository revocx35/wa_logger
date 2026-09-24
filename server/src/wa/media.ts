import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer';
import type { AppContext } from '../context.js';
import { randomBytes } from '../crypto/primitives.js';
import { MediaFileWriter } from '../crypto/stream.js';
import { F } from '../db/repo.js';
import { maskId } from '../log.js';

/* ------------------------------------------------------ encrypted storage */

export interface PendingMediaFile {
  writer: MediaFileWriter;
  relPath: string;
  keyId: number;
}

/** Starts a new encrypted media file under DATA_DIR/media/<xx>/<random>.bin. */
export async function beginMediaFile(ctx: AppContext): Promise<PendingMediaFile> {
  const w = ctx.writer();
  if (!w) throw new Error('no owner key');
  const { id: keyId, key } = w.currentKey();
  const fileId = randomBytes(16);
  const hex = fileId.toString('hex');
  const relPath = `${hex.slice(0, 2)}/${hex}.bin`;
  const abs = path.join(ctx.config.mediaDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  return { writer: await MediaFileWriter.create(abs, key, keyId, fileId), relPath, keyId };
}

/** Finishes the file and records it in the media table. Returns the media id. */
export async function finishMediaFile(
  ctx: AppContext,
  f: PendingMediaFile,
  kind: 'message' | 'avatar',
  mime: string | null,
  filename: string | null,
): Promise<{ mediaId: number; size: number }> {
  const w = ctx.writer();
  if (!w) {
    await f.writer.abort();
    throw new Error('no owner key');
  }
  const { size } = await f.writer.finish();
  const mediaId = ctx.repo.insertMedia({
    path: f.relPath,
    key_id: f.keyId,
    mime_enc: w.encrypt(...F.mediaMime(f.relPath), mime),
    filename_enc: w.encrypt(...F.mediaFilename(f.relPath), filename),
    size,
    kind,
    created_at: Date.now(),
  });
  return { mediaId, size };
}

export async function deleteMediaFile(ctx: AppContext, relPath: string): Promise<void> {
  await fs.rm(path.join(ctx.config.mediaDir, relPath), { force: true });
}

/* ------------------------------------------------- in-page chunked download */

const SLICE = 2 * 1024 * 1024;

type PrepResult =
  | { status: 'ok'; token: string; size: number; mimetype: string | null; filename: string | null }
  | { status: 'too_large'; size: number }
  | { status: 'unavailable' | 'failed' | 'retry' | 'view_once'; reason?: string };

export type DownloadOutcome =
  | { status: 'ok'; mediaId: number; size: number }
  | { status: 'too_large' | 'unavailable' | 'failed' | 'retry' | 'view_once'; reason?: string };

/**
 * Downloads and decrypts media inside the WhatsApp page (same internals whatsapp-web.js uses),
 * then pulls it over CDP in 2 MiB slices and encrypts it straight to disk — large videos never sit
 * in Node memory as one giant base64 string.
 */
const PREP_TIMEOUT_MS = 180_000;

export async function downloadMessageMedia(ctx: AppContext, page: Page, messageId: string, maxBytes: number): Promise<DownloadOutcome> {
  let prepTimer: NodeJS.Timeout | undefined;
  const prepTimeout = new Promise<PrepResult>((resolve) => {
    prepTimer = setTimeout(() => resolve({ status: 'retry', reason: 'timeout' }), PREP_TIMEOUT_MS);
  });
  const prepCall = (page.evaluate(
    async (msgId: string, max: number) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const w = window as any;
      const store: Map<string, { u8: Uint8Array; t: number }> = (w.__walMedia ||= new Map());
      for (const [k, v] of store) if (Date.now() - v.t > 10 * 60_000) store.delete(k);
      const { Msg } = w.require('WAWebCollections');
      const msg = Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0];
      if (!msg) return { status: 'unavailable', reason: 'not_found' };
      if (msg.isViewOnce) return { status: 'view_once' };
      if (!msg.mediaData || !msg.directPath) return { status: 'unavailable', reason: 'no_media' };
      if (typeof msg.size === 'number' && msg.size > max) return { status: 'too_large', size: msg.size };
      if (msg.mediaData.mediaStage === 'REUPLOADING') return { status: 'retry', reason: 'reuploading' };
      // WhatsApp's own calls can wait indefinitely (e.g. for the phone): always race them against a timer.
      const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
        Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
      if (msg.mediaData.mediaStage !== 'RESOLVED') {
        try {
          await within(msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }), 20_000);
        } catch {
          /* fall through to the stage check */
        }
        // Give an in-flight fetch a few seconds to resolve.
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const st = String(msg.mediaData.mediaStage);
          if (st === 'RESOLVED' || st.includes('ERROR') || st === 'NEED_POKE') break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      const stage = String(msg.mediaData.mediaStage);
      if (stage.includes('ERROR')) return { status: 'failed', reason: stage };
      // NEED_POKE after we already asked to download = the CDN copy has expired (404); WhatsApp Web only
      // re-requests it from the phone on a manual click. Report it as unavailable instead of blocking.
      if (stage === 'NEED_POKE') return { status: 'unavailable', reason: 'expired' };
      if (stage !== 'RESOLVED') return { status: 'retry', reason: stage };
      const qpl = {
        addAnnotations() {
          return this;
        },
        addPoint() {
          return this;
        },
      };
      let buf: ArrayBuffer | 'timeout';
      try {
        buf = await within(w.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: qpl,
        }), 120_000);
      } catch (e: any) {
        if (e && (e.status === 404 || e.status === 410)) return { status: 'unavailable', reason: 'gone' };
        return { status: 'failed', reason: 'download_error' };
      }
      if (buf === 'timeout') return { status: 'retry', reason: 'download_timeout' };
      if (buf.byteLength > max) return { status: 'too_large', size: buf.byteLength };
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      store.set(token, { u8: new Uint8Array(buf), t: Date.now() });
      return { status: 'ok', token, size: buf.byteLength, mimetype: msg.mimetype || null, filename: msg.filename || null };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    messageId,
    maxBytes,
  ) as Promise<PrepResult>);
  const prep = await Promise.race([prepCall, prepTimeout]).finally(() => clearTimeout(prepTimer));

  if (prep.status !== 'ok') return prep.status === 'too_large' ? { status: 'too_large' } : prep;

  const file = await beginMediaFile(ctx);
  try {
    for (let off = 0; off < prep.size; off += SLICE) {
      const b64 = (await page.evaluate(
        async (token: string, offset: number, len: number) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry = (window as any).__walMedia?.get(token) as { u8: Uint8Array } | undefined;
          if (!entry) return null;
          const blob = new Blob([entry.u8.subarray(offset, offset + len) as BlobPart]);
          const dataUrl: string = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
          });
          return dataUrl.slice(dataUrl.indexOf(',') + 1);
        },
        prep.token,
        off,
        SLICE,
      )) as string | null;
      if (b64 === null) throw new Error('media slice vanished');
      await file.writer.write(Buffer.from(b64, 'base64'));
    }
    const { mediaId, size } = await finishMediaFile(ctx, file, 'message', prep.mimetype, prep.filename);
    return { status: 'ok', mediaId, size };
  } catch (e) {
    await file.writer.abort();
    throw e;
  } finally {
    await page
      .evaluate((token: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__walMedia?.delete(token);
      }, prep.token)
      .catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ queue */

const MAX_ATTEMPTS = 4;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];

export class MediaQueue {
  private readonly high: string[] = [];
  private readonly low: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private paused = true;
  private readonly timers = new Set<NodeJS.Timeout>();
  private lowDiskWarned = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly getPage: () => Page | null,
    private readonly concurrency = 2,
  ) {}

  size(): number {
    return this.queued.size + this.running;
  }

  enqueue(messageId: string, priority: 'live' | 'history'): void {
    if (this.queued.has(messageId)) return;
    this.queued.add(messageId);
    (priority === 'live' ? this.high : this.low).push(messageId);
    this.pump();
  }

  /** Re-queues every message still marked pending in the DB (e.g. after a restart). */
  restorePending(): void {
    for (const r of this.ctx.repo.pendingMediaMessages(5000)) this.enqueue(r.id, 'history');
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  stop(): void {
    this.paused = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private next(): string | undefined {
    return this.high.shift() ?? this.low.shift();
  }

  private pump(): void {
    while (!this.paused && this.running < this.concurrency) {
      const id = this.next();
      if (!id) return;
      this.queued.delete(id);
      this.running++;
      void this.process(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private retryLater(id: string, attempts: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.enqueue(id, 'history');
    }, BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
    t.unref();
    this.timers.add(t);
  }

  private async process(id: string): Promise<void> {
    const { repo, log, events } = this.ctx;
    const row = repo.getMessage(id);
    if (!row || row.media_status !== 'pending') return;
    const page = this.getPage();
    if (!page) {
      // Not connected: keep it pending; restorePending() picks it up on the next "ready".
      return;
    }
    // Keep headroom on the data filesystem (it may be a dedicated, size-capped volume): never let media
    // downloads fill it up — the database must always be able to write. Checked again on every retry.
    try {
      const st = await fs.statfs(this.ctx.config.mediaDir);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free < MIN_FREE_BYTES + (row.media_size ?? 0)) {
        if (!this.lowDiskWarned) log.warn({ freeMb: Math.round(free / 1048576) }, 'low disk space: media downloads paused');
        this.lowDiskWarned = true;
        this.retryLater(id, BACKOFF_MS.length);
        return;
      }
      this.lowDiskWarned = false;
    } catch {
      /* statfs unsupported: carry on */
    }
    const attempts = row.media_attempts + 1;
    const finish = (patch: Parameters<typeof repo.updateMessage>[1]) => {
      repo.updateMessage(id, { ...patch, media_attempts: attempts, updated_at: Date.now() });
      events.emit({ type: 'message_update', chatId: row.chat_id, messageId: id, reason: 'media' });
    };
    try {
      const out = await downloadMessageMedia(this.ctx, page, id, this.ctx.mediaMaxBytes());
      if (out.status === 'ok') {
        // The row may have been wiped while downloading.
        if (!repo.getMessage(id)) {
          const m = repo.getMedia(out.mediaId);
          if (m) {
            repo.deleteMedia(m.id);
            await deleteMediaFile(this.ctx, m.path);
          }
          return;
        }
        finish({ media_id: out.mediaId, media_status: 'downloaded', media_size: out.size });
        return;
      }
      if (out.status === 'too_large') return finish({ media_status: 'too_large' });
      if (out.status === 'view_once') return finish({ media_status: 'view_once', is_view_once: 1 });
      // Expired on WhatsApp's servers: one confirmation retry, then give up (the UI offers "Retry").
      if (out.status === 'unavailable' && attempts >= 2) return finish({ media_status: 'unavailable' });
      if (attempts >= MAX_ATTEMPTS) {
        return finish({ media_status: out.status === 'unavailable' ? 'unavailable' : 'failed' });
      }
      repo.updateMessage(id, { media_attempts: attempts });
      this.retryLater(id, attempts);
    } catch (err) {
      log.warn({ err: (err as Error).message, msg: maskId(id) }, 'media download error');
      if (attempts >= MAX_ATTEMPTS) return finish({ media_status: 'failed' });
      repo.updateMessage(id, { media_attempts: attempts });
      this.retryLater(id, attempts);
    }
  }
}
