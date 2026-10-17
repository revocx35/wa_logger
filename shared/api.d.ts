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

export interface Reaction {
  senderId: string;
  senderName: string | null;
  emoji: string;
  ts: number;
  /** The owner's own reaction (set by servers that support sending). */
  fromMe?: boolean;
}

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
  /** Sent with disappearing messages on: the timer in seconds (null when off or unknown). WhatsApp doesn't save such media to the phone's gallery. */
  disappearingSec: number | null;
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

/**
 * `GET /api/media-feed?after=&limit=`: messages whose media finished downloading after `after`, oldest first.
 * Without `after` (or with a cursor from before a data wipe) there are no items, only the current cursor.
 * Pass `cursor` as the next `after`; `more` means another page is ready right away.
 */
export interface MediaFeedItem { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface MediaFeedPage { items: MediaFeedItem[]; cursor: string; more: boolean }

export interface SearchHit { chat: { id: string; name: string; kind: ChatKind }; message: Message }
export interface SearchResponse { hits: SearchHit[]; truncated: boolean }

/* ----------------------------------------------------------------- sending */

/** `POST /api/chats/:chatId/send`. The sent message arrives like any other (SSE `message`). */
export interface SendTextRequest { text: string; quotedId?: string | null }
/** The id of the sent message when WhatsApp reported it (null otherwise; it still appears through SSE). */
export interface SendResult { id: string | null }

/**
 * `POST /api/uploads` with the raw file as the body (`Content-Type: application/octet-stream`) and the file name in
 * `X-Filename` (percent-encoded). Kept in memory for 10 minutes until it is sent with `POST /api/chats/:chatId/send-media`.
 */
export interface UploadResponse { uploadId: string; size: number }
/** auto: photo/video/audio by type (other files as documents) · document: always a file · voice: voice note (Ogg/Opus) · gif: video as GIF */
export type SendMediaKind = 'auto' | 'document' | 'voice' | 'gif';
export interface SendMediaRequest { uploadId: string; kind: SendMediaKind; caption?: string | null; quotedId?: string | null }

/** `POST /api/messages/:messageId/react`: an empty `emoji` removes the reaction. */
export interface ReactRequest { emoji: string }
/** `POST /api/messages/:messageId/edit` (own text messages, within WhatsApp's time limit). */
export interface EditRequest { text: string }
/** `POST /api/chats/new`: open (or create) the chat with a phone number on WhatsApp. */
export interface NewChatRequest { phone: string }
export interface NewChatResponse { chatId: string }

/* ------------------------------------------------------------------- calls */

/**
 * incoming: ringing here, not answered · calling: we dial · ringing: the other phone rings ·
 * connecting: answered, audio being set up · active: talking · ended
 */
export type CallState = 'incoming' | 'calling' | 'ringing' | 'connecting' | 'active' | 'ended';
/** completed: was connected and ended normally · elsewhere: answered or declined on another device */
export type CallEndReason = 'completed' | 'declined' | 'busy' | 'missed' | 'unavailable' | 'canceled' | 'elsewhere' | 'failed';

/** A WhatsApp voice call of the linked account (one at a time). Audio goes through `WS /api/calls/audio`. */
export interface CallInfo {
  id: string;
  direction: 'incoming' | 'outgoing';
  state: CallState;
  /** WhatsApp video call: handled as a voice call here (no camera). */
  video: boolean;
  group: boolean;
  /** The chat to show: the other person's (as logged here), or the group's. null when unknown. */
  chatId: string | null;
  /** Display name and picture. Only in `GET /api/calls/current` and the POST responses (SSE events carry no names). */
  name?: string | null;
  avatarUrl?: string | null;
  startedAt: number;
  connectedAt: number | null;
  endedAt: number | null;
  endReason: CallEndReason | null;
  /** A browser or app is connected to the call audio. */
  audio: boolean;
}

/** `GET /api/calls/current`. `available`: WhatsApp is connected and calling is set up in its tab. */
export interface CurrentCall { call: CallInfo | null; available: boolean }

/**
 * `WS /api/calls/audio` (session cookie + same Origin, like `/api/vnc`). One connection at a time; a new one replaces
 * the old (close code 4000). Closed with 1000 when the call ends, 4004 when there is no call.
 * Audio both ways: **binary** messages of 16 kHz mono signed 16-bit little-endian PCM, 20–200 ms each (even length,
 * at most 6400 bytes). The server first sends one text message `CallAudioHello`. Silence may not be sent at all:
 * play silence when nothing arrives.
 */
export interface CallAudioHello { type: 'hello'; sampleRate: 16000; channels: 1; format: 's16le'; callId: string }

/* ------------------------------------------------------------------ events */

export type ServerEvent =
  | { type: 'wa_state'; status: WaStatus }
  | { type: 'message'; chatId: string; messageId: string }
  | { type: 'message_update'; chatId: string; messageId: string; reason: 'deleted' | 'edited' | 'reaction' | 'ack' | 'media' }
  | { type: 'chat_update'; chatId: string }
  | { type: 'sync_progress'; sync: WaStatus['sync'] }
  /** Every state change of a call (no names: fetch `GET /api/calls/current` for the display name). */
  | { type: 'call'; call: CallInfo }
  | { type: 'session_revoked' };

/* ---------------------------------------------------------------- settings */

export interface Settings {
  logStatus: boolean;
  downloadHistoryMedia: boolean;
  mediaMaxMb: number; // 1..2000
  historyPerChat: number; // 0..5000
  /** Mark a chat as read on WhatsApp (blue ticks for the sender) when it is opened here. Default false. */
  readReceipts: boolean;
}

export interface AuditEntry { id: number; ts: number; event: string; ip: string | null; detail: string | null }

export interface WipeRequest { password: string; totp?: string }
