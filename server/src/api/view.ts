import type {
  ChatKind,
  ChatSummary,
  MediaInfo,
  MediaStatus,
  Message,
  MessagePreview,
  MessageType,
  QuotedSnapshot,
  Reaction,
} from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import type { DataReader } from '../crypto/keyring.js';
import { F, type ChatListRow, type ChatRow, type ContactRow, type MessageRow } from '../db/repo.js';
import { phoneOf, renderSystemText, type MessageMeta } from '../wa/mapper.js';

const PREVIEW_LEN = 120;

const MEDIA_LABEL: Partial<Record<MessageType, string>> = {
  image: '📷 Photo',
  video: '🎥 Video',
  gif: 'GIF',
  audio: '🎵 Audio',
  ptt: '🎤 Voice message',
  document: '📄 Document',
  sticker: 'Sticker',
  location: '📍 Location',
  live_location: '📍 Live location',
  vcard: '👤 Contact',
  multi_vcard: '👥 Contacts',
  poll: '📊 Poll',
  call_log: '📞 Call',
  view_once: 'View-once media',
  revoked: 'Deleted message',
  ciphertext: 'Waiting for this message',
};

/**
 * Turns encrypted rows into API DTOs for one request. Holds a request-scoped DataReader and small
 * caches of decrypted names; discarded with the request.
 */
export class Presenter {
  private readonly contactCache = new Map<string, ContactRow | null>();
  private readonly nameCache = new Map<string, string>();
  readonly meId: string | null;

  constructor(
    private readonly ctx: AppContext,
    private readonly reader: DataReader,
  ) {
    this.meId = ctx.repo.getState('wa_me') ?? null;
  }

  /* ---------------------------------------------------------- names */

  preloadContacts(ids: Iterable<string>): void {
    const missing = [...new Set(ids)].filter((id) => !this.contactCache.has(id));
    for (const row of this.ctx.repo.getContactsByIds(missing)) this.contactCache.set(row.id, row);
    for (const id of missing) if (!this.contactCache.has(id)) this.contactCache.set(id, null);
  }

  contactName(id: string | null | undefined): string {
    if (!id) return 'Unknown';
    if (this.meId && id === this.meId) return 'You';
    const cached = this.nameCache.get(id);
    if (cached) return cached;
    if (!this.contactCache.has(id)) this.preloadContacts([id]);
    const row = this.contactCache.get(id);
    let name: string | null = null;
    if (row) {
      name = this.reader.tryText(...F.contactName(id), row.name_enc) ?? null;
      if (!name) {
        const push = this.reader.tryText(...F.contactPushname(id), row.pushname_enc);
        if (push) name = `~${push}`;
      }
      if (!name) name = this.reader.tryText(...F.contactPhone(id), row.phone_enc);
    }
    if (!name) name = phoneOf(id) ?? id.replace(/@.*/, '');
    this.nameCache.set(id, name);
    return name;
  }

  chatName(chat: ChatRow): string {
    const n = this.reader.tryText(...F.chatName(chat.id), chat.name_enc);
    if (n) return n;
    if (chat.kind === 'user') return this.contactName(chat.id);
    if (chat.kind === 'status') return 'Status updates';
    return phoneOf(chat.id) ?? chat.id.replace(/@.*/, '');
  }

  chatRef(chat: ChatRow | undefined, chatId: string): { id: string; name: string; kind: ChatKind } {
    return chat
      ? { id: chat.id, name: this.chatName(chat), kind: chat.kind as ChatKind }
      : { id: chatId, name: phoneOf(chatId) ?? chatId.replace(/@.*/, ''), kind: 'user' };
  }

  /* -------------------------------------------------------- messages */

  private meta(row: MessageRow): MessageMeta | null {
    return this.reader.tryJson<MessageMeta>(...F.meta(row.id), row.meta_enc);
  }

  private text(row: MessageRow, meta: MessageMeta | null): string | null {
    if (row.type === 'system' && meta?.system) {
      return renderSystemText(meta.system, (id) => this.contactName(id), meta.rawType);
    }
    const body = this.reader.tryText(...F.body(row.id), row.body_enc);
    if (body) return body;
    if (meta?.invite) return `Group invite${meta.invite.groupName ? `: ${meta.invite.groupName}` : ''}`;
    return null;
  }

  private media(row: MessageRow): MediaInfo | null {
    const status = row.media_status as MediaStatus;
    const hasMedia = status !== 'none' || row.media_id !== null || ['image', 'video', 'gif', 'audio', 'ptt', 'document', 'sticker', 'view_once'].includes(row.type);
    if (!hasMedia) return null;
    let mime: string | null = null;
    let filename: string | null = null;
    if (row.media_id !== null) {
      const m = this.ctx.repo.getMedia(row.media_id);
      if (m) {
        mime = this.reader.tryText(...F.mediaMime(m.path), m.mime_enc);
        filename = this.reader.tryText(...F.mediaFilename(m.path), m.filename_enc);
      }
    }
    let thumbDataUrl: string | null = null;
    if (row.thumb_enc) {
      try {
        const t = this.reader.decrypt(...F.thumb(row.id), row.thumb_enc);
        if (t) thumbDataUrl = `data:image/jpeg;base64,${t.toString('base64')}`;
      } catch {
        thumbDataUrl = null;
      }
    }
    return {
      status,
      url: row.media_id !== null && status === 'downloaded' ? `/api/media/${row.media_id}` : null,
      mime,
      filename,
      size: row.media_size,
      width: row.media_w,
      height: row.media_h,
      durationSec: row.media_duration,
      thumbDataUrl,
    };
  }

  /** Builds full DTOs for a batch of rows (one DB round trip each for reactions, edits, contacts). */
  messages(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const metas = new Map(rows.map((r) => [r.id, this.meta(r)] as const));
    const people = new Set<string>();
    for (const r of rows) {
      if (r.sender_id) people.add(r.sender_id);
      const m = metas.get(r.id);
      if (m?.quoted?.participant) people.add(m.quoted.participant);
      for (const x of m?.mentions ?? []) people.add(x);
      if (m?.system?.author) people.add(m.system.author);
      for (const x of m?.system?.recipients ?? []) people.add(x);
    }
    const reactions = this.ctx.repo.reactionsFor(ids);
    for (const r of reactions) people.add(r.sender_id);
    this.preloadContacts(people);
    const editCounts = this.ctx.repo.editCounts(ids);
    const byMsg = new Map<string, Reaction[]>();
    for (const r of reactions) {
      if (r.removed_at) continue;
      const emoji = this.reader.tryText(...F.reaction(r.message_id, r.sender_id), r.emoji_enc);
      if (!emoji) continue;
      const list = byMsg.get(r.message_id) ?? [];
      list.push({ senderId: r.sender_id, senderName: this.contactName(r.sender_id), emoji, ts: r.ts });
      byMsg.set(r.message_id, list);
    }

    return rows.map((row) => {
      const meta = metas.get(row.id) ?? null;
      let quoted: QuotedSnapshot | null = null;
      if (meta?.quoted) {
        const q = meta.quoted;
        const fromMe = !!this.meId && q.participant === this.meId;
        quoted = {
          id: q.stanzaId ? this.ctx.repo.findByStanza(row.chat_id, q.stanzaId) : null,
          senderName: fromMe ? 'You' : q.participant ? this.contactName(q.participant) : null,
          fromMe,
          type: q.type,
          text: q.text,
        };
      }
      const msg: Message = {
        id: row.id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        senderName: row.from_me ? 'You' : row.sender_id ? this.contactName(row.sender_id) : null,
        fromMe: !!row.from_me,
        ts: row.ts,
        type: row.type as MessageType,
        text: this.text(row, meta),
        media: this.media(row),
        quoted,
        location: meta?.location ?? null,
        vcards: meta?.vcards ?? null,
        poll: meta?.poll ?? null,
        call: meta?.call ?? null,
        mentions: (meta?.mentions ?? []).map((id) => ({ id, name: this.contactName(id) })),
        forwarded: !!row.is_forwarded,
        isStatus: !!row.is_status,
        ack: row.ack,
        reactions: byMsg.get(row.id) ?? [],
        edited: row.edited_at !== null || (editCounts.get(row.id) ?? 0) > 0,
        editedAt: row.edited_at,
        editCount: editCounts.get(row.id) ?? 0,
        deletedAt: row.deleted_at,
        deletedBy: row.deleted_by,
        deletedForMeAt: row.deleted_for_me_at,
        source: row.source === 'history' ? 'history' : 'live',
        capturedAt: row.captured_at,
      };
      return msg;
    });
  }

  preview(row: MessageRow): MessagePreview {
    const meta = this.meta(row);
    let text = this.text(row, meta);
    if (!text) text = MEDIA_LABEL[row.type as MessageType] ?? null;
    else if (MEDIA_LABEL[row.type as MessageType] && row.type !== 'system') text = `${MEDIA_LABEL[row.type as MessageType]} · ${text}`;
    if (text && text.length > PREVIEW_LEN) text = `${text.slice(0, PREVIEW_LEN - 1)}…`;
    return {
      id: row.id,
      type: row.type as MessageType,
      fromMe: !!row.from_me,
      senderName: row.from_me ? 'You' : row.sender_id ? this.contactName(row.sender_id) : null,
      text,
      deleted: row.deleted_at !== null,
      ts: row.ts,
    };
  }

  chats(rows: ChatListRow[]): ChatSummary[] {
    const lastIds = rows.map((r) => r.lm_id).filter((x): x is string => !!x);
    const lastRows = new Map(this.ctx.repo.getMessagesByIds(lastIds).map((r) => [r.id, r] as const));
    this.preloadContacts([...rows.filter((r) => r.kind === 'user').map((r) => r.id), ...[...lastRows.values()].map((r) => r.sender_id).filter((x): x is string => !!x)]);
    return rows.map((c) => {
      const last = c.lm_id ? lastRows.get(c.lm_id) : undefined;
      return {
        id: c.id,
        kind: c.kind as ChatKind,
        name: this.chatName(c),
        avatarUrl: c.avatar_media_id ? `/api/media/${c.avatar_media_id}` : null,
        lastTs: last?.ts ?? c.last_ts,
        lastMessage: last ? this.preview(last) : null,
        archived: !!c.archived,
        pinned: !!c.pinned,
        muted: !!c.muted,
        removed: c.removed_at !== null,
        messageCount: c.message_count,
        deletedCount: c.deleted_count,
      };
    });
  }

  /** Plain text used for search matching (body, captions, poll/location/contact names). */
  searchableText(row: MessageRow): string {
    const parts: string[] = [];
    const body = this.reader.tryText(...F.body(row.id), row.body_enc);
    if (body) parts.push(body);
    const meta = row.meta_enc ? this.meta(row) : null;
    if (meta?.poll) parts.push(meta.poll.question, ...meta.poll.options.map((o) => o.name));
    if (meta?.location) parts.push(meta.location.name ?? '', meta.location.address ?? '');
    if (meta?.vcards) parts.push(...meta.vcards.map((v) => v.displayName ?? ''));
    return parts.join('\n');
  }
}
