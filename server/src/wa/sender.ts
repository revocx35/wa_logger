import type { SendMediaKind, SendResult } from '../../../shared/api.js';
import type { AppContext, WaSender } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { maskId } from '../log.js';
import { beginMediaFile, finishMediaFile } from './media.js';
import { PageOpError, type WalPage } from './walbridge.js';

const CHUNK = 1024 * 1024;
/** Sends per rolling hour, on top of the per-route rate limits: a stolen session must not get the account banned. */
const MAX_SENDS_PER_HOUR = 300;

/** Page error codes (walpage.ts fail()) → API errors. Messages from the page are written to be shown. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof PageOpError) {
    switch (e.code) {
      case 'not_found':
        return new AppError(404, 'not_found', e.message);
      case 'not_allowed':
        return Errors.conflict(e.message);
      case 'validation':
        return Errors.validation(e.message);
      case 'send_failed':
        return new AppError(502, 'send_failed', e.message);
      case 'timeout':
        return new AppError(504, 'timeout', e.message);
      case 'not_ready':
        return Errors.unavailable('WhatsApp Web is still loading. Try again in a moment.');
      default:
        return new AppError(502, 'wa_error', 'WhatsApp Web could not do that.');
    }
  }
  return new AppError(502, 'wa_error', 'WhatsApp Web could not do that.');
}

/**
 * Sending through the WhatsApp tab (walpage.ts). What gets sent is logged like every other message (it comes back
 * through message_create); media we sent is stored from the uploaded file, so it never has to be downloaded again.
 */
export class Sender implements WaSender {
  private readonly sent: number[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly wal: () => WalPage | null,
    private readonly ensureChat: (chatId: string) => Promise<void>,
  ) {}

  private page(): WalPage {
    const w = this.wal();
    if (!w) throw Errors.unavailable('WhatsApp is not connected.');
    return w;
  }

  private charge(): void {
    const now = Date.now();
    while (this.sent.length && this.sent[0]! < now - 3600_000) this.sent.shift();
    if (this.sent.length >= MAX_SENDS_PER_HOUR) throw Errors.rateLimited((this.sent[0]! + 3600_000 - now) / 1000);
    this.sent.push(now);
  }

  private async run<T>(op: string, args: unknown, timeoutMs?: number): Promise<T> {
    try {
      return await this.page().call<T>(op, args, timeoutMs);
    } catch (e) {
      throw toAppError(e);
    }
  }

  async sendText(chatId: string, text: string, quotedId: string | null): Promise<SendResult> {
    this.charge();
    const r = await this.run<{ id: string | null }>('sendText', { chatId, text, quotedId }, 70_000);
    this.ctx.repo.audit('message_sent', null, 'text');
    return { id: r?.id ?? null };
  }

  async sendMedia(
    chatId: string,
    file: { data: Buffer; mime: string; filename: string | null },
    kind: SendMediaKind,
    caption: string | null,
    quotedId: string | null,
  ): Promise<SendResult> {
    this.charge();
    const page = this.page();
    let token: string | null = null;
    try {
      token = await page.call<string>('uploadBegin', { size: file.data.length }, 30_000);
      for (let off = 0; off < file.data.length; off += CHUNK) {
        await page.call('uploadChunk', { token, offset: off, b64: file.data.subarray(off, off + CHUNK).toString('base64') }, 60_000);
      }
      const r = await page.call<{ id: string | null }>(
        'sendMedia',
        { chatId, token, mime: file.mime, filename: file.filename, kind, caption, quotedId },
        330_000,
      );
      token = null; // the page dropped it
      this.ctx.repo.audit('message_sent', null, kind === 'auto' ? 'media' : kind);
      if (r?.id) void this.storeSentMedia(r.id, file).catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'storing sent media failed'));
      return { id: r?.id ?? null };
    } catch (e) {
      throw toAppError(e);
    } finally {
      if (token) await page.call('uploadDrop', { token }, 10_000).catch(() => undefined);
    }
  }

  /**
   * WhatsApp adds the message to the chat before the upload finishes, so ingest logged it without a downloadable
   * file. Store the uploaded bytes for it instead (encrypted like everything else).
   */
  async storeSentMedia(messageId: string, file: { data: Buffer; mime: string; filename: string | null }): Promise<void> {
    const { repo, events } = this.ctx;
    let row = repo.getMessage(messageId);
    for (let i = 0; !row && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      row = repo.getMessage(messageId);
    }
    if (!row || row.media_id || row.media_status === 'downloaded') return;
    const f = await beginMediaFile(this.ctx);
    try {
      await f.writer.write(file.data);
    } catch (e) {
      await f.writer.abort();
      throw e;
    }
    const { mediaId, size } = await finishMediaFile(this.ctx, f, 'message', file.mime, file.filename);
    repo.updateMessage(messageId, { media_id: mediaId, media_status: 'downloaded', media_size: size, updated_at: Date.now() });
    events.emit({ type: 'message_update', chatId: row.chat_id, messageId, reason: 'media' });
    this.ctx.log.debug({ msg: maskId(messageId) }, 'stored sent media');
  }

  async react(messageId: string, emoji: string): Promise<void> {
    this.charge();
    await this.run('react', { id: messageId, emoji }, 40_000);
  }

  async revoke(messageId: string): Promise<void> {
    this.charge();
    await this.run('revoke', { id: messageId }, 40_000);
    this.ctx.repo.audit('message_revoked', null);
  }

  async edit(messageId: string, text: string): Promise<void> {
    this.charge();
    await this.run('edit', { id: messageId, text }, 70_000);
  }

  async markRead(chatId: string): Promise<void> {
    await this.run('markRead', { chatId }, 30_000);
  }

  async openChat(phone: string): Promise<string | null> {
    const chatId = await this.run<string | null>('resolvePhone', { phone }, 30_000);
    if (chatId) await this.ensureChat(chatId);
    return chatId;
  }
}
