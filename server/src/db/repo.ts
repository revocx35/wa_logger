import type { DataKeyStore, WrappedDek } from '../crypto/keyring.js';
import type { DB } from './db.js';

/* ---------------------------------------------------------------- rows */

export interface OwnerRow {
  id: 1;
  username: string;
  pw_salt: Buffer;
  pw_auth_hash: Buffer;
  public_key: Buffer;
  privkey_pw: Buffer;
  privkey_recovery: Buffer;
  recovery_salt: Buffer;
  recovery_auth_hash: Buffer;
  totp_secret_enc: Buffer | null;
  totp_enabled: number;
  totp_last_step: number | null;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  password_changed_at: number;
}

export interface SessionRow {
  id_hash: Buffer;
  privkey_enc: Buffer;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  event: string;
  ip: string | null;
  detail: string | null;
}

export interface MediaRow {
  id: number;
  path: string;
  key_id: number;
  mime_enc: Buffer | null;
  filename_enc: Buffer | null;
  size: number;
  kind: 'message' | 'avatar';
  created_at: number;
}

export interface ChatRow {
  id: string;
  kind: string;
  name_enc: Buffer | null;
  last_ts: number | null;
  archived: number;
  pinned: number;
  muted: number;
  removed_at: number | null;
  avatar_media_id: number | null;
  avatar_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ContactRow {
  id: string;
  name_enc: Buffer | null;
  pushname_enc: Buffer | null;
  is_me: number;
  is_business: number;
  avatar_media_id: number | null;
  avatar_checked_at: number | null;
  updated_at: number;
}

export interface MessageRow {
  rowid: number;
  id: string;
  chat_id: string;
  sender_id: string | null;
  from_me: number;
  ts: number;
  type: string;
  body_enc: Buffer | null;
  meta_enc: Buffer | null;
  thumb_enc: Buffer | null;
  quoted_id: string | null;
  media_id: number | null;
  media_status: string;
  media_attempts: number;
  media_size: number | null;
  media_w: number | null;
  media_h: number | null;
  media_duration: number | null;
  is_view_once: number;
  is_forwarded: number;
  is_status: number;
  ack: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  deleted_for_me_at: number | null;
  edited_at: number | null;
  last_edit_key: string | null;
  source: string;
  captured_at: number;
  updated_at: number;
}

export type NewMessage = Omit<MessageRow, 'rowid'>;

export interface EditRow {
  id: number;
  message_id: string;
  body_enc: Buffer | null;
  captured_at: number;
}

export interface ReactionRow {
  message_id: string;
  sender_id: string;
  emoji_enc: Buffer | null;
  ts: number;
  removed_at: number | null;
}

export interface ChatListRow extends ChatRow {
  message_count: number;
  deleted_count: number;
  lm_id: string | null;
}

/* ------------------------------------------------------------- cursors */

export interface Cursor {
  ts: number;
  rowid: number;
}

export function encodeCursor(c: Cursor): string {
  return `${c.ts}_${c.rowid}`;
}

export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  const m = /^(\d{1,16})_(\d{1,16})$/.exec(s);
  if (!m) return null;
  return { ts: Number(m[1]), rowid: Number(m[2]) };
}

/* ----------------------------------------------------------------- AAD */

/** Field-encryption contexts. Message bodies and their edit history share the "msgbody" context. */
export const F = {
  chatName: (id: string) => ['chats', 'name', id] as const,
  contactName: (id: string) => ['contacts', 'name', id] as const,
  contactPushname: (id: string) => ['contacts', 'pushname', id] as const,
  body: (messageId: string) => ['msgbody', 'body', messageId] as const,
  meta: (messageId: string) => ['messages', 'meta', messageId] as const,
  thumb: (messageId: string) => ['messages', 'thumb', messageId] as const,
  reaction: (messageId: string, senderId: string) => ['reactions', 'emoji', `${messageId}|${senderId}`] as const,
  mediaMime: (path: string) => ['media', 'mime', path] as const,
  mediaFilename: (path: string) => ['media', 'filename', path] as const,
};

/* ---------------------------------------------------------------- repo */

const OWNER_UPDATABLE = new Set<keyof OwnerRow>([
  'pw_salt',
  'pw_auth_hash',
  'privkey_pw',
  'privkey_recovery',
  'recovery_salt',
  'recovery_auth_hash',
  'totp_secret_enc',
  'totp_enabled',
  'totp_last_step',
  'failed_logins',
  'locked_until',
  'password_changed_at',
]);

const MESSAGE_UPDATABLE = new Set<keyof MessageRow>([
  'sender_id',
  'from_me',
  'ts',
  'type',
  'body_enc',
  'meta_enc',
  'thumb_enc',
  'quoted_id',
  'media_id',
  'media_status',
  'media_attempts',
  'media_size',
  'media_w',
  'media_h',
  'media_duration',
  'is_view_once',
  'is_forwarded',
  'is_status',
  'ack',
  'deleted_at',
  'deleted_by',
  'deleted_for_me_at',
  'edited_at',
  'last_edit_key',
  'updated_at',
]);

function buildUpdate<T extends object>(allowed: Set<keyof T>, patch: Partial<T>): { sets: string; values: unknown[] } {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) as (keyof T)[];
  for (const k of keys) if (!allowed.has(k)) throw new Error(`column not updatable: ${String(k)}`);
  return {
    sets: keys.map((k) => `${String(k)} = ?`).join(', '),
    values: keys.map((k) => (patch as Record<string, unknown>)[k as string]),
  };
}

const MSG_COLS = 'rowid, *';

export class Repo implements DataKeyStore {
  constructor(public readonly db: DB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* ------------------------------------------------------------ state */

  getState(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key);
  }

  /* ------------------------------------------------------------ owner */

  getOwner(): OwnerRow | undefined {
    return this.db.prepare('SELECT * FROM owner WHERE id = 1').get() as OwnerRow | undefined;
  }

  hasOwner(): boolean {
    return !!this.db.prepare('SELECT 1 FROM owner WHERE id = 1').get();
  }

  /** Returns false if an owner already exists (signup race). */
  createOwner(row: Omit<OwnerRow, 'id' | 'totp_secret_enc' | 'totp_enabled' | 'totp_last_step' | 'failed_logins' | 'locked_until'>): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO owner (id, username, pw_salt, pw_auth_hash, public_key, privkey_pw, privkey_recovery,
           recovery_salt, recovery_auth_hash, created_at, password_changed_at)
         VALUES (1, @username, @pw_salt, @pw_auth_hash, @public_key, @privkey_pw, @privkey_recovery,
           @recovery_salt, @recovery_auth_hash, @created_at, @password_changed_at)`,
      )
      .run(row);
    return res.changes === 1;
  }

  updateOwner(patch: Partial<OwnerRow>): void {
    const { sets, values } = buildUpdate(OWNER_UPDATABLE, patch);
    if (!sets) return;
    this.db.prepare(`UPDATE owner SET ${sets} WHERE id = 1`).run(...values);
  }

  /* --------------------------------------------------------- sessions */

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, privkey_enc, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES (@id_hash, @privkey_enc, @created_at, @last_seen_at, @expires_at, @ip, @user_agent)`,
      )
      .run(row);
  }

  getSession(idHash: Buffer): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
  }

  touchSession(idHash: Buffer, lastSeenAt: number, ip: string | null): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id_hash = ?').run(lastSeenAt, ip, idHash);
  }

  deleteSession(idHash: Buffer): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteSessionByPrefix(hexPrefix: string): number {
    if (!/^[0-9a-f]{16}$/.test(hexPrefix)) return 0;
    return this.db.prepare("DELETE FROM sessions WHERE substr(lower(hex(id_hash)), 1, 16) = ?").run(hexPrefix).changes;
  }

  deleteAllSessions(exceptIdHash?: Buffer): number {
    if (exceptIdHash) return this.db.prepare('DELETE FROM sessions WHERE id_hash != ?').run(exceptIdHash).changes;
    return this.db.prepare('DELETE FROM sessions').run().changes;
  }

  deleteExpiredSessions(now: number, idleMs: number): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - idleMs).changes;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC').all() as SessionRow[];
  }

  /* ------------------------------------------------------------ audit */

  audit(event: string, ip: string | null, detail?: string | null, ts = Date.now()): void {
    this.db.prepare('INSERT INTO audit_log (ts, event, ip, detail) VALUES (?, ?, ?, ?)').run(ts, event, ip, detail ?? null);
    // Keep the audit log bounded.
    this.db.prepare('DELETE FROM audit_log WHERE id <= (SELECT MAX(id) - 5000 FROM audit_log)').run();
  }

  listAudit(limit: number, beforeId?: number): AuditRow[] {
    if (beforeId) {
      return this.db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit) as AuditRow[];
    }
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[];
  }

  /* -------------------------------------------------------- data keys */

  insertDataKey(ephPub: Buffer, wrapped: Buffer, createdAt: number): number {
    const r = this.db.prepare('INSERT INTO data_keys (eph_pub, wrapped, created_at) VALUES (?, ?, ?)').run(ephPub, wrapped, createdAt);
    return Number(r.lastInsertRowid);
  }

  getDataKey(id: number): WrappedDek | undefined {
    const r = this.db.prepare('SELECT eph_pub, wrapped FROM data_keys WHERE id = ?').get(id) as
      | { eph_pub: Buffer; wrapped: Buffer }
      | undefined;
    return r ? { ephPub: r.eph_pub, wrapped: r.wrapped } : undefined;
  }

  /* ------------------------------------------------------------ media */

  insertMedia(row: Omit<MediaRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO media (path, key_id, mime_enc, filename_enc, size, kind, created_at)
         VALUES (@path, @key_id, @mime_enc, @filename_enc, @size, @kind, @created_at)`,
      )
      .run(row);
    return Number(r.lastInsertRowid);
  }

  getMedia(id: number): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
  }

  deleteMedia(id: number): void {
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
  }

  allMediaPaths(): string[] {
    return (this.db.prepare('SELECT path FROM media').all() as { path: string }[]).map((r) => r.path);
  }

  /* ------------------------------------------------------------ chats */

  getChat(id: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
  }

  upsertChat(c: {
    id: string;
    kind: string;
    name_enc?: Buffer | null;
    last_ts?: number | null;
    archived?: boolean;
    pinned?: boolean;
    muted?: boolean;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, kind, name_enc, last_ts, archived, pinned, muted, created_at, updated_at)
         VALUES (@id, @kind, @name_enc, @last_ts, @archived, @pinned, @muted, @now, @now)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind,
           name_enc = COALESCE(excluded.name_enc, chats.name_enc),
           last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0)),
           archived = CASE WHEN @has_archived THEN excluded.archived ELSE chats.archived END,
           pinned = CASE WHEN @has_pinned THEN excluded.pinned ELSE chats.pinned END,
           muted = CASE WHEN @has_muted THEN excluded.muted ELSE chats.muted END,
           removed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: c.id,
        kind: c.kind,
        name_enc: c.name_enc ?? null,
        last_ts: c.last_ts ?? null,
        archived: c.archived ? 1 : 0,
        pinned: c.pinned ? 1 : 0,
        muted: c.muted ? 1 : 0,
        has_archived: c.archived === undefined ? 0 : 1,
        has_pinned: c.pinned === undefined ? 0 : 1,
        has_muted: c.muted === undefined ? 0 : 1,
        now: c.now,
      });
  }

  bumpChatTs(id: string, ts: number, now: number): void {
    this.db.prepare('UPDATE chats SET last_ts = MAX(COALESCE(last_ts, 0), ?), updated_at = ? WHERE id = ?').run(ts, now, id);
  }

  markChatRemoved(id: string, at: number): void {
    this.db.prepare('UPDATE chats SET removed_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  }

  setChatArchived(id: string, archived: boolean, now: number): void {
    this.db.prepare('UPDATE chats SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, now, id);
  }

  setChatAvatar(id: string, mediaId: number | null, checkedAt: number): void {
    this.db.prepare('UPDATE chats SET avatar_media_id = ?, avatar_checked_at = ? WHERE id = ?').run(mediaId, checkedAt, id);
  }

  chatsNeedingAvatar(olderThan: number, limit: number): ChatRow[] {
    return this.db
      .prepare('SELECT * FROM chats WHERE avatar_checked_at IS NULL OR avatar_checked_at < ? ORDER BY last_ts DESC LIMIT ?')
      .all(olderThan, limit) as ChatRow[];
  }

  listChats(): ChatListRow[] {
    return this.db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NOT NULL) AS deleted_count,
           (SELECT m.id FROM messages m WHERE m.chat_id = c.id ORDER BY m.ts DESC, m.rowid DESC LIMIT 1) AS lm_id
         FROM chats c
         ORDER BY c.pinned DESC, COALESCE(c.last_ts, 0) DESC`,
      )
      .all() as ChatListRow[];
  }

  getChatsByIds(ids: string[]): ChatRow[] {
    if (ids.length === 0) return [];
    const out: ChatRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT * FROM chats WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as ChatRow[]));
    }
    return out;
  }

  /* --------------------------------------------------------- contacts */

  getContact(id: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  }

  getContactsByIds(ids: string[]): ContactRow[] {
    if (ids.length === 0) return [];
    const out: ContactRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT * FROM contacts WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as ContactRow[]));
    }
    return out;
  }

  upsertContact(c: {
    id: string;
    name_enc?: Buffer | null;
    pushname_enc?: Buffer | null;
    is_me?: boolean;
    is_business?: boolean;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (id, name_enc, pushname_enc, is_me, is_business, updated_at)
         VALUES (@id, @name_enc, @pushname_enc, @is_me, @is_business, @now)
         ON CONFLICT (id) DO UPDATE SET
           name_enc = COALESCE(excluded.name_enc, contacts.name_enc),
           pushname_enc = COALESCE(excluded.pushname_enc, contacts.pushname_enc),
           is_me = MAX(contacts.is_me, excluded.is_me),
           is_business = excluded.is_business,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: c.id,
        name_enc: c.name_enc ?? null,
        pushname_enc: c.pushname_enc ?? null,
        is_me: c.is_me ? 1 : 0,
        is_business: c.is_business ? 1 : 0,
        now: c.now,
      });
  }

  setContactAvatar(id: string, mediaId: number | null, checkedAt: number): void {
    this.db.prepare('UPDATE contacts SET avatar_media_id = ?, avatar_checked_at = ? WHERE id = ?').run(mediaId, checkedAt, id);
  }

  /* --------------------------------------------------------- messages */

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
  }

  getMessagesByIds(ids: string[]): MessageRow[] {
    if (ids.length === 0) return [];
    const out: MessageRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as MessageRow[]));
    }
    return out;
  }

  /** Inserts if absent. Returns true when a row was inserted. */
  insertMessage(m: NewMessage): boolean {
    const cols = Object.keys(m);
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
      .run(m);
    return r.changes === 1;
  }

  updateMessage(id: string, patch: Partial<MessageRow>): void {
    const { sets, values } = buildUpdate(MESSAGE_UPDATABLE, patch);
    if (!sets) return;
    this.db.prepare(`UPDATE messages SET ${sets} WHERE id = ?`).run(...values, id);
  }

  /** Newest-first page older than `before`, returned in ascending order. */
  listMessagesBefore(chatId: string, before: Cursor | null, limit: number): MessageRow[] {
    const rows = before
      ? (this.db
          .prepare(
            `SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND (ts < ? OR (ts = ? AND rowid < ?))
             ORDER BY ts DESC, rowid DESC LIMIT ?`,
          )
          .all(chatId, before.ts, before.ts, before.rowid, limit) as MessageRow[])
      : (this.db
          .prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
          .all(chatId, limit) as MessageRow[]);
    return rows.reverse();
  }

  /** Oldest-first page newer than `after` (exclusive). */
  listMessagesAfter(chatId: string, after: Cursor, limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND (ts > ? OR (ts = ? AND rowid > ?))
         ORDER BY ts ASC, rowid ASC LIMIT ?`,
      )
      .all(chatId, after.ts, after.ts, after.rowid, limit) as MessageRow[];
  }

  listDeleted(before: Cursor | null, limit: number): MessageRow[] {
    if (before) {
      return this.db
        .prepare(
          `SELECT ${MSG_COLS} FROM messages WHERE deleted_at IS NOT NULL AND (deleted_at < ? OR (deleted_at = ? AND rowid < ?))
           ORDER BY deleted_at DESC, rowid DESC LIMIT ?`,
        )
        .all(before.ts, before.ts, before.rowid, limit) as MessageRow[];
    }
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as MessageRow[];
  }

  /** Batch of messages with a body/meta for search scanning, newest first. */
  scanForSearch(chatId: string | null, before: Cursor | null, limit: number): MessageRow[] {
    const where: string[] = ['(body_enc IS NOT NULL OR meta_enc IS NOT NULL)'];
    const args: unknown[] = [];
    if (chatId) {
      where.push('chat_id = ?');
      args.push(chatId);
    }
    if (before) {
      where.push('(ts < ? OR (ts = ? AND rowid < ?))');
      args.push(before.ts, before.ts, before.rowid);
    }
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(...args, limit) as MessageRow[];
  }

  pendingMediaMessages(limit: number): MessageRow[] {
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE media_status = 'pending' ORDER BY ts DESC LIMIT ?`)
      .all(limit) as MessageRow[];
  }

  countPendingMedia(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE media_status = 'pending'`).get() as { n: number }).n;
  }

  /* ------------------------------------------------------------ edits */

  insertEdit(messageId: string, bodyEnc: Buffer | null, capturedAt: number): void {
    this.db.prepare('INSERT INTO message_edits (message_id, body_enc, captured_at) VALUES (?, ?, ?)').run(messageId, bodyEnc, capturedAt);
  }

  listEdits(messageId: string): EditRow[] {
    return this.db.prepare('SELECT * FROM message_edits WHERE message_id = ? ORDER BY id ASC').all(messageId) as EditRow[];
  }

  editCounts(messageIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const part = messageIds.slice(i, i + 500);
      if (part.length === 0) continue;
      const rows = this.db
        .prepare(`SELECT message_id, COUNT(*) AS n FROM message_edits WHERE message_id IN (${part.map(() => '?').join(',')}) GROUP BY message_id`)
        .all(...part) as { message_id: string; n: number }[];
      for (const r of rows) out.set(r.message_id, r.n);
    }
    return out;
  }

  /* -------------------------------------------------------- reactions */

  upsertReaction(r: { message_id: string; sender_id: string; emoji_enc: Buffer | null; ts: number; removed: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO reactions (message_id, sender_id, emoji_enc, ts, removed_at)
         VALUES (@message_id, @sender_id, @emoji_enc, @ts, @removed_at)
         ON CONFLICT (message_id, sender_id) DO UPDATE SET
           emoji_enc = COALESCE(excluded.emoji_enc, reactions.emoji_enc),
           ts = excluded.ts,
           removed_at = excluded.removed_at
         WHERE excluded.ts >= reactions.ts`,
      )
      .run({ ...r, removed_at: r.removed ? r.ts : null });
  }

  reactionsFor(messageIds: string[]): ReactionRow[] {
    const out: ReactionRow[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const part = messageIds.slice(i, i + 500);
      if (part.length === 0) continue;
      out.push(
        ...(this.db
          .prepare(`SELECT * FROM reactions WHERE message_id IN (${part.map(() => '?').join(',')}) ORDER BY ts ASC`)
          .all(...part) as ReactionRow[]),
      );
    }
    return out;
  }

  /* ------------------------------------------------------------- wipe */

  /** Deletes all logged WhatsApp data (keeps owner, sessions, audit, settings). Returns media paths to unlink. */
  wipeLoggedData(): string[] {
    return this.transaction(() => {
      const paths = this.allMediaPaths();
      this.db.exec(`
        DELETE FROM reactions;
        DELETE FROM message_edits;
        DELETE FROM messages;
        DELETE FROM contacts;
        DELETE FROM chats;
        DELETE FROM media;
      `);
      return paths;
    });
  }
}
