import type { AppContext } from '../context.js';
import { F, type MessageRow, type NewMessage } from '../db/repo.js';
import { chatKind, jid, looksLikeBase64Blob, mapMessage, type MappedMessage, type RawMsg } from './mapper.js';

/** The subset of the WhatsApp client ingest needs (abstracted for tests). */
export interface WaApi {
  getChat(chatId: string): Promise<{
    name: string | null;
    timestamp: number | null; // epoch ms
    archived: boolean;
    pinned: boolean;
    muted: boolean;
  } | null>;
  getContact(id: string): Promise<{ name: string | null; pushname: string | null; isMe: boolean; isBusiness: boolean } | null>;
}

export interface MediaSink {
  enqueue(messageId: string, priority: 'live' | 'history'): void;
}

export type Source = 'live' | 'history';

const CHAT_REFRESH_MS = 6 * 3600_000;
const CONTACT_REFRESH_MS = 24 * 3600_000;

/**
 * Turns WhatsApp events into encrypted DB rows. Every handler is idempotent (keyed by the serialized
 * message id), so live events, history import and reconcile can overlap safely.
 */
export class Ingest {
  private readonly chatSeen = new Map<string, number>();
  private readonly contactSeen = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly api: WaApi,
    private readonly media: MediaSink,
  ) {}

  private get writer() {
    return this.ctx.writer();
  }

  resetCaches(): void {
    this.chatSeen.clear();
    this.contactSeen.clear();
  }

  /* ------------------------------------------------------------- chats */

  async ensureChat(chatId: string, force = false): Promise<void> {
    const w = this.writer;
    if (!w) return;
    const now = Date.now();
    const seen = this.chatSeen.get(chatId);
    if (!force && seen && now - seen < CHAT_REFRESH_MS && this.ctx.repo.getChat(chatId)) return;
    this.chatSeen.set(chatId, now);
    const kind = chatKind(chatId);
    let info: Awaited<ReturnType<WaApi['getChat']>> = null;
    try {
      info = kind === 'status' ? null : await this.api.getChat(chatId);
    } catch {
      info = null;
    }
    const name = kind === 'status' ? 'Status updates' : info?.name ?? null;
    this.ctx.repo.upsertChat({
      id: chatId,
      kind,
      name_enc: w.encrypt(...F.chatName(chatId), name),
      last_ts: info?.timestamp ?? null,
      ...(info ? { archived: info.archived, pinned: info.pinned, muted: info.muted } : {}),
      now,
    });
    this.ctx.events.emit({ type: 'chat_update', chatId });
  }

  /** Used by sync with already-fetched chat info (avoids a second round trip). */
  upsertChatInfo(chatId: string, info: { name: string | null; timestamp: number | null; archived: boolean; pinned: boolean; muted: boolean }): void {
    const w = this.writer;
    if (!w) return;
    const now = Date.now();
    this.chatSeen.set(chatId, now);
    const kind = chatKind(chatId);
    this.ctx.repo.upsertChat({
      id: chatId,
      kind,
      name_enc: w.encrypt(...F.chatName(chatId), kind === 'status' ? 'Status updates' : info.name),
      last_ts: info.timestamp,
      archived: info.archived,
      pinned: info.pinned,
      muted: info.muted,
      now,
    });
  }

  async ensureContact(id: string, notifyName: string | null, force = false): Promise<void> {
    const w = this.writer;
    if (!w) return;
    const now = Date.now();
    const seen = this.contactSeen.get(id);
    if (!force && seen && now - seen < CONTACT_REFRESH_MS) return;
    this.contactSeen.set(id, now);
    let info: Awaited<ReturnType<WaApi['getContact']>> = null;
    try {
      info = await this.api.getContact(id);
    } catch {
      info = null;
    }
    this.ctx.repo.upsertContact({
      id,
      name_enc: w.encrypt(...F.contactName(id), info?.name ?? null),
      pushname_enc: w.encrypt(...F.contactPushname(id), info?.pushname ?? notifyName),
      is_me: info?.isMe ?? false,
      is_business: info?.isBusiness ?? false,
      now,
    });
  }

  /* ---------------------------------------------------------- messages */

  private mediaStatusFor(m: MappedMessage, source: Source): string {
    if (m.isViewOnce) return 'view_once';
    if (!m.media) return 'none';
    if (!m.downloadable) return 'unavailable';
    if (m.media.size && m.media.size > this.ctx.mediaMaxBytes()) return 'too_large';
    if (source === 'history' && !this.ctx.settings.get().downloadHistoryMedia) return 'skipped';
    return 'pending';
  }

  private contentFields(m: MappedMessage, source: Source): Omit<NewMessage, 'id' | 'chat_id' | 'source' | 'captured_at' | 'updated_at'> {
    const w = this.writer!;
    return {
      sender_id: m.senderId,
      from_me: m.fromMe ? 1 : 0,
      ts: m.ts,
      type: m.type,
      body_enc: w.encrypt(...F.body(m.id), m.body),
      meta_enc: w.encryptJson(...F.meta(m.id), m.meta),
      thumb_enc: m.thumbBase64 ? w.encrypt(...F.thumb(m.id), Buffer.from(m.thumbBase64, 'base64')) : null,
      quoted_id: m.quotedStanzaId,
      media_id: null,
      media_status: this.mediaStatusFor(m, source),
      media_attempts: 0,
      media_size: m.media?.size ?? null,
      media_w: m.media?.width ?? null,
      media_h: m.media?.height ?? null,
      media_duration: m.media?.durationSec ?? null,
      is_view_once: m.isViewOnce ? 1 : 0,
      is_forwarded: m.isForwarded ? 1 : 0,
      is_status: m.isStatus ? 1 : 0,
      ack: m.ack,
      deleted_at: null,
      deleted_by: null,
      deleted_for_me_at: null,
      edited_at: m.editKey ? (m.editTs ?? m.ts) : null,
      last_edit_key: m.editKey,
    };
  }

  /** Handles message_create / history / reconcile for one message. Returns the stored row id or null. */
  async message(raw: RawMsg, source: Source): Promise<string | null> {
    const w = this.writer;
    if (!w) return null;
    const m = mapMessage(raw);
    if (m.skip) return null;
    if (m.isStatus && !this.ctx.settings.get().logStatus) return null;

    await this.ensureChat(m.chatId);
    if (m.senderId && !m.fromMe) await this.ensureContact(m.senderId, m.notifyName);

    const { repo, events } = this.ctx;
    const now = Date.now();
    const existing = repo.getMessage(m.id);

    if (!existing) {
      if (m.revoked) {
        this.insertRevokedStub(m, source, now);
        return m.id;
      }
      const row: NewMessage = {
        id: m.id,
        chat_id: m.chatId,
        ...this.contentFields(m, source),
        source,
        captured_at: now,
        updated_at: now,
      };
      if (repo.insertMessage(row)) {
        repo.bumpChatTs(m.chatId, m.ts, now);
        if (row.media_status === 'pending') this.media.enqueue(m.id, source);
        events.emit({ type: 'message', chatId: m.chatId, messageId: m.id });
      }
      return m.id;
    }

    this.updateExisting(existing, m, source, now);
    return m.id;
  }

  private insertRevokedStub(m: MappedMessage, source: Source, now: number): void {
    const { repo, events } = this.ctx;
    const inserted = repo.insertMessage({
      id: m.id,
      chat_id: m.chatId,
      sender_id: m.senderId,
      from_me: m.fromMe ? 1 : 0,
      ts: m.ts,
      type: 'revoked',
      body_enc: null,
      meta_enc: null,
      thumb_enc: null,
      quoted_id: null,
      media_id: null,
      media_status: 'none',
      media_attempts: 0,
      media_size: null,
      media_w: null,
      media_h: null,
      media_duration: null,
      is_view_once: 0,
      is_forwarded: 0,
      is_status: m.isStatus ? 1 : 0,
      ack: m.ack,
      // Seen only as already-deleted during history import: the real deletion time is unknown, so use
      // the message time rather than pretending it was deleted "now".
      deleted_at: source === 'history' ? m.ts || now : now,
      deleted_by: m.revokedBy ?? 'sender',
      deleted_for_me_at: null,
      edited_at: null,
      last_edit_key: null,
      source,
      captured_at: now,
      updated_at: now,
    });
    if (inserted) {
      repo.bumpChatTs(m.chatId, m.ts, now);
      events.emit({ type: 'message', chatId: m.chatId, messageId: m.id });
    }
  }

  private updateExisting(existing: MessageRow, m: MappedMessage, source: Source, now: number): void {
    const { repo, events } = this.ctx;

    // Deleted for everyone — keep the logged content, just flag it.
    if (m.revoked) {
      if (!existing.deleted_at) {
        repo.updateMessage(existing.id, { deleted_at: now, deleted_by: m.revokedBy ?? 'sender', updated_at: now });
        events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'deleted' });
      }
      return;
    }

    // Placeholder rows (undecrypted ciphertext / revoked stub) get their real content now.
    if ((existing.type === 'ciphertext' || (existing.type === 'revoked' && !existing.body_enc && !existing.meta_enc)) && m.type !== 'ciphertext') {
      const fields = this.contentFields(m, source);
      repo.updateMessage(existing.id, {
        ...fields,
        // A revoked stub stays flagged as deleted.
        deleted_at: existing.deleted_at,
        deleted_by: existing.deleted_by,
        updated_at: now,
      });
      if (fields.media_status === 'pending') this.media.enqueue(existing.id, source);
      events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'edited' });
      return;
    }

    // An edit we have not recorded yet (missed live event, or history/reconcile).
    if (m.editKey && m.editKey !== existing.last_edit_key && !existing.deleted_at && m.type !== 'ciphertext') {
      this.applyEdit(existing, m.body, m.editKey, m.editTs ?? now, now);
    }

    const patch: Parameters<typeof repo.updateMessage>[1] = {};
    if (m.ack !== null && (existing.ack === null || m.ack > existing.ack)) patch.ack = m.ack;
    // Media that failed earlier can be retried when WhatsApp offers it again.
    if (existing.media_status === 'failed' && m.downloadable && existing.media_attempts < 8) {
      patch.media_status = 'pending';
      this.media.enqueue(existing.id, source);
    }
    if (Object.keys(patch).length) {
      repo.updateMessage(existing.id, { ...patch, updated_at: now });
      events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: patch.ack !== undefined ? 'ack' : 'media' });
    }
  }

  /**
   * Moves the current body ciphertext into the edit history (both share the "msgbody" AAD context,
   * so no decryption is needed) and stores the new body.
   */
  private applyEdit(existing: MessageRow, newBody: string | null, editKey: string, editTs: number, now: number): void {
    const { repo, events } = this.ctx;
    const w = this.writer!;
    repo.transaction(() => {
      repo.insertEdit(existing.id, existing.body_enc, now);
      repo.updateMessage(existing.id, {
        body_enc: w.encrypt(...F.body(existing.id), newBody),
        edited_at: editTs,
        last_edit_key: editKey,
        updated_at: now,
      });
    });
    events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'edited' });
  }

  /** whatsapp-web.js `message_edit(message, newBody, prevBody)`. */
  async edit(raw: RawMsg, newBody: unknown, prevBody: unknown): Promise<void> {
    const w = this.writer;
    if (!w) return;
    const m = mapMessage(raw);
    if (m.skip || m.revoked) return;
    const existing = this.ctx.repo.getMessage(m.id);
    if (!existing) {
      // First sight of an edited message: store it, and keep the previous text as history.
      await this.message(raw, 'live');
      const prev = typeof prevBody === 'string' ? prevBody : null;
      if (prev && !looksLikeBase64Blob(prev) && prev !== m.body) {
        this.ctx.repo.insertEdit(m.id, w.encrypt(...F.body(m.id), prev), Date.now());
      }
      return;
    }
    if (existing.type === 'ciphertext' || existing.deleted_at) {
      await this.message(raw, 'live');
      return;
    }
    const next = typeof newBody === 'string' ? newBody : null;
    const prev = typeof prevBody === 'string' ? prevBody : null;
    // body/caption change events also fire for thumbnail updates on media — ignore those.
    if (looksLikeBase64Blob(next) || looksLikeBase64Blob(prev)) return;
    if (m.editKey) {
      if (m.editKey !== existing.last_edit_key) this.applyEdit(existing, m.body, m.editKey, m.editTs ?? Date.now(), Date.now());
      return;
    }
    if (prev !== null && next !== null && prev !== next && m.type === 'chat') {
      const now = Date.now();
      this.applyEdit(existing, next, `evt:${now}`, now, now);
    }
  }

  /** whatsapp-web.js `message_revoke_everyone(after, before?)`. */
  async revoke(afterRaw: RawMsg, beforeRaw: RawMsg | null): Promise<void> {
    if (!this.writer) return;
    const after = mapMessage(afterRaw);
    const { repo, events } = this.ctx;
    const now = Date.now();
    let existing = repo.getMessage(after.id);
    if (beforeRaw) {
      const before = mapMessage(beforeRaw);
      const target = repo.getMessage(before.id) ?? existing;
      if (!target) {
        // Never logged (e.g. app was down): store the original content from `before` first.
        await this.message({ ...beforeRaw, id: afterRaw.id ?? beforeRaw.id }, 'live');
        existing = repo.getMessage(after.id);
      } else if (target.type === 'revoked' && !target.body_enc) {
        await this.message({ ...beforeRaw, id: afterRaw.id ?? beforeRaw.id }, 'live');
        existing = repo.getMessage(after.id);
      } else {
        existing = target;
      }
    }
    if (!existing) {
      await this.ensureChat(after.chatId);
      this.insertRevokedStub({ ...after, revoked: true }, 'live', now);
      return;
    }
    if (!existing.deleted_at) {
      repo.updateMessage(existing.id, { deleted_at: now, deleted_by: after.revokedBy ?? 'sender', updated_at: now });
      events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'deleted' });
    }
  }

  /** whatsapp-web.js `message_revoke_me(message)` — deleted only on the owner's devices. */
  revokeMe(raw: RawMsg): void {
    const m = mapMessage(raw);
    const existing = this.ctx.repo.getMessage(m.id);
    if (!existing || existing.deleted_for_me_at) return;
    const now = Date.now();
    this.ctx.repo.updateMessage(existing.id, { deleted_for_me_at: now, updated_at: now });
    this.ctx.events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'deleted' });
  }

  /** whatsapp-web.js `message_reaction(reaction)`. */
  reaction(r: { msgId: unknown; senderId: unknown; reaction: unknown; timestamp: unknown }): void {
    const w = this.writer;
    if (!w) return;
    const messageId = jid(r.msgId);
    const senderId = jid(r.senderId);
    if (!messageId || !senderId) return;
    const existing = this.ctx.repo.getMessage(messageId);
    if (!existing) return;
    const emoji = typeof r.reaction === 'string' ? r.reaction : '';
    let ts = typeof r.timestamp === 'number' ? r.timestamp : Date.now();
    if (ts < 1e12) ts *= 1000;
    this.ctx.repo.upsertReaction({
      message_id: messageId,
      sender_id: senderId,
      emoji_enc: emoji ? w.encrypt(...F.reaction(messageId, senderId), emoji) : null,
      ts,
      removed: emoji === '',
    });
    this.ctx.events.emit({ type: 'message_update', chatId: existing.chat_id, messageId, reason: 'reaction' });
  }

  ack(raw: RawMsg, ack: unknown): void {
    const m = mapMessage(raw);
    const a = typeof ack === 'number' ? ack : null;
    if (a === null) return;
    const existing = this.ctx.repo.getMessage(m.id);
    if (!existing || (existing.ack !== null && existing.ack >= a)) return;
    this.ctx.repo.updateMessage(existing.id, { ack: a, updated_at: Date.now() });
    this.ctx.events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'ack' });
  }

  /** Group notifications (join/leave/admin/subject…) arrive as GroupNotification objects, not messages. */
  async groupNotification(n: { id: unknown; type?: unknown; body?: unknown; timestamp?: unknown; chatId?: unknown; author?: unknown; recipientIds?: unknown }): Promise<void> {
    const idObj = n.id as RawMsg | undefined;
    if (!idObj) return;
    const chatId = jid(n.chatId) ?? jid(idObj.remote);
    if (!chatId) return;
    const raw: RawMsg = {
      id: { ...idObj, remote: chatId },
      type: 'gp2',
      subtype: typeof n.type === 'string' ? n.type : null,
      t: typeof n.timestamp === 'number' ? n.timestamp : Math.floor(Date.now() / 1000),
      author: jid(n.author),
      recipients: Array.isArray(n.recipientIds) ? n.recipientIds : [],
      body: typeof n.body === 'string' ? n.body : null,
    };
    await this.message(raw, 'live');
    if (raw.subtype === 'subject' || raw.subtype === 'create') await this.ensureChat(chatId, true);
  }

  chatRemoved(chatId: string): void {
    const now = Date.now();
    if (!this.ctx.repo.getChat(chatId)) return;
    this.ctx.repo.markChatRemoved(chatId, now);
    this.ctx.events.emit({ type: 'chat_update', chatId });
  }

  chatArchived(chatId: string, archived: boolean): void {
    if (!this.ctx.repo.getChat(chatId)) return;
    this.ctx.repo.setChatArchived(chatId, archived, Date.now());
    this.ctx.events.emit({ type: 'chat_update', chatId });
  }
}
