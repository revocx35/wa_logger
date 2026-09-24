/**
 * wa_logger HTTP API contract — shared by server (`server/`) and web UI (`web/`).
 * Type-only declaration file: never put runtime code here.
 * Timestamps are Unix epoch **milliseconds** unless stated otherwise.
 * See ARCHITECTURE.md §8 for the route table.
 */

/* ------------------------------------------------------------------ errors */

export interface ApiError {
  error: {
    /** Stable machine code, e.g. "unauthorized", "invalid_credentials", "rate_limited", "validation", "conflict", "not_found", "internal". */
    code: string;
    /** Human-readable, safe to show to the user. Never contains internals. */
    message: string;
    /** Seconds until retry is allowed (rate limit / lockout). */
    retryAfter?: number;
  };
}

/* ------------------------------------------------------------------- state */

export type WaState =
  | 'idle' //           no owner yet / client not started
  | 'starting' //       connecting to Chromium, loading WhatsApp Web
  | 'qr' //             waiting for the user to scan the QR code
  | 'authenticating' // QR scanned, WhatsApp Web is loading the session
  | 'syncing' //        ready, initial history import running
  | 'ready' //          fully connected and logging
  | 'disconnected' //   phone unlinked / logged out / conflict — needs attention
  | 'error'; //         browser unreachable etc. (auto-retrying)

export interface WaStatus {
  state: WaState;
  /** Short safe description, e.g. "Chromium unreachable, retrying in 10s". */
  detail?: string;
  /** The linked account (only when authenticated). */
  me?: { id: string; name: string | null; phone: string | null };
  /** Initial sync / reconcile progress. */
  sync?: { phase: 'history' | 'reconcile'; chatsDone: number; chatsTotal: number } | null;
  /** Pending media downloads. */
  mediaQueue: number;
  since: number;
}

export interface AppState {
  hasOwner: boolean;
  authenticated: boolean;
  onboardingComplete: boolean;
  /** Present when authenticated: send as `X-CSRF-Token` on every non-GET request. */
  csrfToken?: string;
  username?: string;
  /** Whether TOTP two-factor authentication is enabled (authenticated only). */
  totpEnabled?: boolean;
  wa?: WaStatus;
}

/* -------------------------------------------------------------------- auth */

export interface SignupRequest { setupToken: string; username: string; password: string }
export interface SignupResponse { recoveryKey: string }

export interface LoginRequest { username: string; password: string; totp?: string }
/** On success: `{ ok: true }`. If TOTP is enabled and missing/invalid: `{ ok: false, needTotp: true }`. */
export interface LoginResponse { ok: boolean; needTotp?: boolean }

export interface RecoverRequest { username: string; recoveryKey: string; newPassword: string }
export interface RecoverResponse { recoveryKey: string }

export interface ChangePasswordRequest { currentPassword: string; newPassword: string }

export interface SessionInfo {
  id: string; // opaque, safe to expose (hash prefix), used for DELETE
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface TotpSetupResponse { secret: string; otpauthUrl: string }
export interface TotpEnableRequest { code: string; password: string }
export interface TotpDisableRequest { password: string; code: string }
export interface RotateRecoveryKeyRequest { password: string; totp?: string }
export interface RotateRecoveryKeyResponse { recoveryKey: string }

export interface VncCredentials { password: string }

/* -------------------------------------------------------------- chats etc. */

export type ChatKind = 'user' | 'group' | 'broadcast' | 'status' | 'newsletter';

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  name: string; // decrypted display name (falls back to phone / id)
  avatarUrl: string | null; // "/api/media/<id>" or null
  lastTs: number | null;
  lastMessage: MessagePreview | null;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  /** Chat was removed/cleared on WhatsApp but is kept in the log. */
  removed: boolean;
  messageCount: number;
  deletedCount: number;
}

export interface MessagePreview {
  id: string;
  type: MessageType;
  fromMe: boolean;
  senderName: string | null;
  text: string | null; // body or caption, truncated to ~120 chars
  deleted: boolean;
  ts: number;
}

export type MessageType =
  | 'chat' | 'image' | 'video' | 'gif' | 'audio' | 'ptt' | 'document' | 'sticker'
  | 'location' | 'live_location' | 'vcard' | 'multi_vcard' | 'poll' | 'call_log'
  | 'system' | 'revoked' | 'ciphertext' | 'view_once' | 'unknown';

/**
 * none: no media · pending: queued/downloading · downloaded: available at `url` · failed: download failed (retryable)
 * too_large: above the size cap (retryable after raising it) · skipped: history media not downloaded (setting)
 * view_once: view-once media, never logged · unavailable: WhatsApp no longer has it (expired/deleted before download)
 */
export type MediaStatus = 'none' | 'pending' | 'downloaded' | 'failed' | 'too_large' | 'skipped' | 'view_once' | 'unavailable';

export interface MediaInfo {
  status: MediaStatus;
  url: string | null; // "/api/media/<id>" when downloaded
  mime: string | null;
  filename: string | null;
  size: number | null; // bytes
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** Small inline preview as data URL (image/jpeg), if WhatsApp provided one. */
  thumbDataUrl: string | null;
}

export interface QuotedSnapshot {
  id: string | null;
  senderName: string | null;
  fromMe: boolean;
  type: MessageType;
  text: string | null;
}

export interface Reaction { senderId: string; senderName: string | null; emoji: string; ts: number }

export interface LocationInfo { latitude: number; longitude: number; name?: string | null; address?: string | null; url?: string | null }
export interface VcardInfo { displayName: string | null; vcard: string }
export interface PollInfo { question: string; options: { name: string; votes: number | null }[]; multiSelect: boolean }
export interface CallLogInfo { video: boolean; outcome: string | null; durationSec: number | null }

export interface Message {
  id: string;
  chatId: string;
  senderId: string | null;
  senderName: string | null;
  fromMe: boolean;
  ts: number;
  type: MessageType;
  /** Body text / caption / rendered system text. null for pure media. */
  text: string | null;
  media: MediaInfo | null;
  quoted: QuotedSnapshot | null;
  location: LocationInfo | null;
  vcards: VcardInfo[] | null;
  poll: PollInfo | null;
  call: CallLogInfo | null;
  mentions: { id: string; name: string | null }[];
  forwarded: boolean;
  isStatus: boolean;
  ack: number | null; // -1 error, 0 pending, 1 server, 2 device, 3 read, 4 played
  reactions: Reaction[];
  edited: boolean;
  editedAt: number | null;
  editCount: number;
  /** Deleted for everyone (revoked) — content above is the logged copy. */
  deletedAt: number | null;
  deletedBy: string | null; // "sender" | "admin" | id
  /** Deleted only on the owner's devices. */
  deletedForMeAt: number | null;
  source: 'live' | 'history';
  capturedAt: number;
}

export interface MessagePage {
  messages: Message[]; // ascending by ts within the page
  /** Pass as `before` to load older messages; null when no older messages exist. */
  nextBefore: string | null;
  /** For `around` pages: cursor for newer messages; null when at the newest message. */
  nextAfter?: string | null;
}

export interface MessageEdit { body: string | null; capturedAt: number }

export interface DeletedFeedItem { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface DeletedFeedPage { items: DeletedFeedItem[]; nextBefore: string | null }

export interface SearchHit { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface SearchResponse { hits: SearchHit[]; truncated: boolean }

/* ------------------------------------------------------------------ events */

export type ServerEvent =
  | { type: 'wa_state'; status: WaStatus }
  | { type: 'message'; chatId: string; messageId: string }
  | { type: 'message_update'; chatId: string; messageId: string; reason: 'deleted' | 'edited' | 'reaction' | 'ack' | 'media' }
  | { type: 'chat_update'; chatId: string }
  | { type: 'sync_progress'; sync: WaStatus['sync'] }
  | { type: 'session_revoked' };

/* ---------------------------------------------------------------- settings */

export interface Settings {
  logStatus: boolean;
  downloadHistoryMedia: boolean;
  mediaMaxMb: number; // 1..2000
  historyPerChat: number; // 0..5000
}

export interface AuditEntry { id: number; ts: number; event: string; ip: string | null; detail: string | null }

export interface WipeRequest { password: string; totp?: string }
