import type { AppContext } from './context.js';
import { deleteMediaFile } from './wa/media.js';

const DAY_MS = 24 * 60 * 60_000;
const BATCH = 500;
/** Message types whose media file the photo/video retention removes (the message, caption and thumbnail stay). */
export const RETAINED_MEDIA_TYPES = ['image', 'video', 'gif', 'sticker'] as const;

/** Oldest message time (ms) still kept, or null when that kind of data is kept forever. */
export function retentionCutoff(days: number, now: number): number | null {
  return days > 0 ? now - days * DAY_MS : null;
}

/**
 * Storage controls: deletes logged messages and photo/video files older than the owner's retention settings
 * (Settings → Storage). Runs at start-up, every hour and whenever a retention setting changes. Ingest and the media
 * queue check the same cutoffs, so history sync doesn't log (or download) what this would delete again.
 */
export class RetentionService {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(intervalMs = 60 * 60_000): void {
    this.ctx.settings.onChange(() => this.trigger());
    this.timer = setInterval(() => this.trigger(), intervalMs);
    this.timer.unref();
    const t = setTimeout(() => this.trigger(), 30_000);
    t.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts a sweep (or queues one more after the running one). */
  trigger(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.sweep(Date.now());
        } while (this.again);
      } catch (err) {
        this.ctx.log.warn({ err: (err as Error).message }, 'retention sweep failed');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** One pass over both settings. Returns how many messages and media files were removed. */
  async sweep(now: number): Promise<{ messages: number; media: number }> {
    const { repo, settings, events } = this.ctx;
    const s = settings.get();
    let messages = 0;
    let media = 0;
    const chats = new Set<string>();

    const msgCutoff = retentionCutoff(s.messageRetentionDays, now);
    if (msgCutoff !== null) {
      for (;;) {
        const ids = repo.messageIdsBefore(msgCutoff, BATCH);
        if (!ids.length) break;
        // No tombstones: the cutoff itself keeps history sync from logging these again.
        const out = repo.removeMessages(ids, now, false);
        for (const r of out.removed) chats.add(r.chatId);
        messages += out.removed.length;
        await this.unlink(out.paths);
        if (ids.length < BATCH) break;
      }
    }

    const mediaCutoff = retentionCutoff(s.mediaRetentionDays, now);
    if (mediaCutoff !== null) {
      for (;;) {
        const rows = repo.mediaMessagesBefore(mediaCutoff, RETAINED_MEDIA_TYPES, BATCH);
        if (!rows.length) break;
        const paths = repo.expireMessageMedia(rows.map((r) => r.id), now);
        for (const r of rows) chats.add(r.chat_id);
        media += paths.length;
        await this.unlink(paths);
        if (rows.length < BATCH) break;
      }
    }

    if (messages || media) {
      repo.audit('retention_sweep', null, `${messages} messages, ${media} media files`);
      for (const chatId of chats) events.emit({ type: 'chat_update', chatId });
    }
    return { messages, media };
  }

  private async unlink(paths: string[]): Promise<void> {
    for (const p of paths) await deleteMediaFile(this.ctx, p).catch(() => undefined);
  }
}
