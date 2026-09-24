import type { CallLogInfo, ChatKind, LocationInfo, MessageType, PollInfo, VcardInfo } from '../../../shared/api.js';

/**
 * Pure mapping from WhatsApp Web's serialized message model (`message._data` in whatsapp-web.js)
 * to our storage record. No I/O, no crypto — unit tested with fixtures in mapper.test.ts.
 */

// Serialized WA models are loosely typed; we read them defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawMsg = Record<string, any>;

export function jid(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && '_serialized' in v) {
    const s = (v as { _serialized: unknown })._serialized;
    return typeof s === 'string' ? s : null;
  }
  return null;
}

/**
 * Serialized WhatsApp message key: `<fromMe>_<remote>_<id>[_<participant>][_<self>]` (e.g. own messages end
 * in "_out"). Older builds exposed it as `_serialized`; current WhatsApp Web builds don't, so it is rebuilt
 * from the key's parts (verified identical to WhatsApp's own MsgKey.toString() on every loaded message).
 */
export function msgKey(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return null;
  const o = v as RawMsg;
  if (typeof o._serialized === 'string' && o._serialized) return o._serialized;
  const remote = jid(o.remote);
  if (!remote || typeof o.id !== 'string' || !o.id) return null;
  const participant = jid(o.participant);
  const self = typeof o.self === 'string' && o.self ? `_${o.self}` : '';
  return `${o.fromMe ? 'true' : 'false'}_${remote}_${o.id}${participant ? `_${participant}` : ''}${self}`;
}

export function chatKind(chatId: string): ChatKind {
  if (chatId === 'status@broadcast') return 'status';
  if (chatId.endsWith('@g.us')) return 'group';
  if (chatId.endsWith('@newsletter')) return 'newsletter';
  if (chatId.endsWith('@broadcast')) return 'broadcast';
  return 'user';
}

/** Phone number part of a user JID (only for phone-number JIDs, not @lid). */
export function phoneOf(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = /^(\d{5,20})@(c\.us|s\.whatsapp\.net)$/.exec(id);
  return m ? `+${m[1]}` : null;
}

export interface SystemInfo {
  subtype: string | null;
  author: string | null;
  recipients: string[];
  /** Extra text carried by the notification (e.g. new group subject). */
  text: string | null;
  templateParams?: string[];
}

export interface QuotedInfo {
  stanzaId: string | null;
  participant: string | null;
  type: MessageType;
  text: string | null;
}

export interface MessageMeta {
  quoted?: QuotedInfo;
  location?: LocationInfo;
  vcards?: VcardInfo[];
  poll?: PollInfo;
  call?: CallLogInfo;
  mentions?: string[];
  system?: SystemInfo;
  rawType?: string;
  invite?: { groupName: string | null };
  forwardingScore?: number;
}

export interface MediaFacts {
  mime: string | null;
  filename: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface MappedMessage {
  id: string;
  chatId: string;
  senderId: string | null;
  fromMe: boolean;
  /** epoch ms */
  ts: number;
  type: MessageType;
  rawType: string;
  /** Text, caption, or null. Never a thumbnail. */
  body: string | null;
  meta: MessageMeta | null;
  /** Base64 JPEG thumbnail provided inline by WhatsApp (if any). */
  thumbBase64: string | null;
  quotedStanzaId: string | null;
  media: MediaFacts | null;
  /** True when WhatsApp holds downloadable media for this message (and it is not view-once). */
  downloadable: boolean;
  isViewOnce: boolean;
  isForwarded: boolean;
  isStatus: boolean;
  ack: number | null;
  revoked: boolean;
  revokedBy: string | null;
  editKey: string | null;
  editTs: number | null;
  notifyName: string | null;
  /** Protocol/noise messages that are not worth storing. */
  skip: boolean;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'ptv']);
const SKIP_TYPES = new Set(['protocol', 'debug', 'e2e_notification', 'reaction', 'album', 'pin_message', 'keep_in_chat', 'poll_update', 'event_response']);
const SYSTEM_TYPES = new Set(['gp2', 'notification_template', 'broadcast_notification', 'group_notification', 'notification', 'call_log_notification']);
const MAX_THUMB_B64 = 96 * 1024;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function looksLikeBase64Blob(s: string | null | undefined): boolean {
  return !!s && s.length >= 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(s.slice(0, 4096));
}

function mapType(raw: RawMsg, rawType: string): MessageType {
  switch (rawType) {
    case 'chat':
      return 'chat';
    case 'image':
      return 'image';
    case 'video':
    case 'ptv':
      return raw.isGif ? 'gif' : 'video';
    case 'audio':
      return 'audio';
    case 'ptt':
      return 'ptt';
    case 'document':
      return 'document';
    case 'sticker':
      return 'sticker';
    case 'location':
      return raw.isLive ? 'live_location' : 'location';
    case 'vcard':
      return 'vcard';
    case 'multi_vcard':
      return 'multi_vcard';
    case 'poll_creation':
      return 'poll';
    case 'call_log':
      return 'call_log';
    case 'revoked':
      return 'revoked';
    case 'ciphertext':
      return 'ciphertext';
    default:
      return SYSTEM_TYPES.has(rawType) ? 'system' : 'unknown';
  }
}

const MAX_VCARD_CHARS = 32 * 1024;
const MAX_VCARDS = 30;

/** Linear-time FN: extraction (a regex spanning lines here was a ReDoS vector for crafted vCards). */
function vcardName(vcard: string): string | null {
  for (const line of vcard.slice(0, MAX_VCARD_CHARS).split(/\r?\n/, 500)) {
    if (line.length < 3 || (line[0] !== 'F' && line[0] !== 'f') || (line[1] !== 'N' && line[1] !== 'n')) continue;
    if (line[2] !== ':' && line[2] !== ';') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(colon + 1).trim();
    if (name) return name.slice(0, 200);
  }
  return null;
}

function quotedText(q: RawMsg): string | null {
  const t = String(q.type ?? '');
  if (MEDIA_TYPES.has(t)) return str(q.caption);
  if (t === 'poll_creation') return str(q.pollName);
  if (t === 'location') return 'Location';
  if (t === 'vcard' || t === 'multi_vcard') return 'Contact';
  const b = str(q.body);
  return b && !looksLikeBase64Blob(b) ? b : null;
}

export function mapMessage(raw: RawMsg): MappedMessage {
  const idObj = raw.id ?? {};
  const id = msgKey(idObj) ?? '';
  const rawType = String(raw.type ?? 'unknown');
  const fromMe = !!idObj.fromMe;
  const chatId = jid(idObj.remote) ?? (fromMe ? jid(raw.to) : jid(raw.from)) ?? 'unknown@c.us';
  const isGroupish = chatId.endsWith('@g.us') || chatId === 'status@broadcast' || chatId.endsWith('@broadcast');
  const senderId = fromMe
    ? null
    : isGroupish
      ? (jid(raw.author) ?? jid(idObj.participant) ?? jid(raw.from))
      : (jid(raw.from) ?? chatId);
  const type = mapType(raw, rawType);
  const isViewOnce = raw.isViewOnce === true || /view_once/i.test(rawType);
  const hasDirectPath = typeof raw.directPath === 'string' && raw.directPath.length > 0;
  const isMedia = MEDIA_TYPES.has(rawType);

  let body: string | null = null;
  let thumbBase64: string | null = null;
  if (isMedia) {
    body = str(raw.caption);
    const b = str(raw.body);
    if (b && looksLikeBase64Blob(b) && b.length <= MAX_THUMB_B64 && !isViewOnce) thumbBase64 = b;
  } else if (rawType === 'poll_creation') {
    body = str(raw.pollName);
  } else if (rawType === 'vcard' || rawType === 'multi_vcard' || rawType === 'location') {
    body = null;
  } else if (SYSTEM_TYPES.has(rawType) || rawType === 'revoked' || rawType === 'ciphertext' || rawType === 'call_log') {
    body = null;
  } else {
    const b = str(raw.body);
    body = b && !looksLikeBase64Blob(b) ? b : null;
  }

  const meta: MessageMeta = {};
  if (raw.quotedMsg && typeof raw.quotedMsg === 'object') {
    const q = raw.quotedMsg as RawMsg;
    meta.quoted = {
      stanzaId: str(raw.quotedStanzaID),
      participant: jid(raw.quotedParticipant),
      type: mapType(q, String(q.type ?? 'unknown')),
      text: quotedText(q),
    };
  }
  if (rawType === 'location') {
    const lat = num(raw.lat);
    const lng = num(raw.lng);
    if (lat !== null && lng !== null) {
      const [name, address] = typeof raw.loc === 'string' ? raw.loc.split('\n') : [];
      meta.location = { latitude: lat, longitude: lng, name: name || null, address: address || null, url: str(raw.clientUrl) };
    }
  }
  if (rawType === 'vcard') {
    const v = (str(raw.body) ?? '').slice(0, MAX_VCARD_CHARS);
    meta.vcards = [{ displayName: str(raw.vcardFormattedName)?.slice(0, 200) ?? vcardName(v), vcard: v }];
  }
  if (rawType === 'multi_vcard' && Array.isArray(raw.vcardList)) {
    meta.vcards = (raw.vcardList as RawMsg[]).slice(0, MAX_VCARDS).map((c) => {
      const v = String(c.vcard ?? '').slice(0, MAX_VCARD_CHARS);
      return { displayName: str(c.displayName)?.slice(0, 200) ?? vcardName(v), vcard: v };
    });
  }
  if (rawType === 'poll_creation') {
    const opts = Array.isArray(raw.pollOptions) ? (raw.pollOptions as RawMsg[]) : [];
    meta.poll = {
      question: str(raw.pollName) ?? '',
      options: opts.map((o) => ({ name: String(o.name ?? ''), votes: null })),
      multiSelect: num(raw.pollSelectableOptionsCount) === 0,
    };
  }
  if (rawType === 'call_log') {
    meta.call = {
      video: !!raw.isVideoCall,
      outcome: str(raw.callOutcome),
      durationSec: num(raw.callDuration),
    };
  }
  if (Array.isArray(raw.mentionedJidList) && raw.mentionedJidList.length) {
    meta.mentions = (raw.mentionedJidList as unknown[]).map(jid).filter((x): x is string => !!x);
  }
  if (SYSTEM_TYPES.has(rawType)) {
    meta.system = {
      subtype: str(raw.subtype),
      author: jid(raw.author) ?? jid(idObj.participant),
      recipients: Array.isArray(raw.recipients) ? (raw.recipients as unknown[]).map(jid).filter((x): x is string => !!x) : [],
      text: str(raw.body) && !looksLikeBase64Blob(raw.body) ? String(raw.body).slice(0, 1000) : null,
      ...(Array.isArray(raw.templateParams)
        ? { templateParams: (raw.templateParams as unknown[]).map((x) => jid(x) ?? String(x)).slice(0, 20) }
        : {}),
    };
  }
  if (rawType === 'groups_v4_invite') meta.invite = { groupName: str(raw.inviteGrpName) };
  if (type === 'unknown') meta.rawType = rawType;
  if (num(raw.forwardingScore)) meta.forwardingScore = num(raw.forwardingScore)!;

  const media: MediaFacts | null = isMedia
    ? {
        mime: str(raw.mimetype),
        filename: str(raw.filename),
        size: num(raw.size),
        width: num(raw.width),
        height: num(raw.height),
        durationSec: num(raw.duration),
      }
    : null;

  const tSec = num(raw.t) ?? 0;
  const editKeyObj = raw.latestEditMsgKey;
  const editKey = editKeyObj ? (msgKey(editKeyObj) ?? str(editKeyObj.id) ?? null) : null;

  return {
    id,
    chatId,
    senderId,
    fromMe,
    ts: Math.round(tSec * 1000),
    type: isViewOnce && isMedia ? 'view_once' : type,
    rawType,
    body,
    meta: Object.keys(meta).length ? meta : null,
    thumbBase64,
    quotedStanzaId: meta.quoted?.stanzaId ?? null,
    media,
    downloadable: isMedia && hasDirectPath && !isViewOnce,
    isViewOnce,
    isForwarded: !!raw.isForwarded,
    isStatus: !!raw.isStatusV3 || chatId === 'status@broadcast',
    ack: num(raw.ack),
    revoked: rawType === 'revoked',
    revokedBy: rawType === 'revoked' ? (str(raw.subtype) === 'admin' ? 'admin' : 'sender') : null,
    editKey,
    editTs: num(raw.latestEditSenderTimestampMs),
    notifyName: str(raw.notifyName),
    // Never store a message without its full key (media, quotes and reactions are looked up by it).
    skip: SKIP_TYPES.has(rawType) || !id || !id.includes('_'),
  };
}

/* --------------------------------------------------- system message text */

export function renderSystemText(sys: SystemInfo, nameOf: (id: string | null) => string, rawType?: string): string {
  const who = nameOf(sys.author);
  const whom = sys.recipients.map((r) => nameOf(r)).join(', ') || 'someone';
  switch (sys.subtype) {
    case 'add':
      return `${who} added ${whom}`;
    case 'invite':
      return `${whom} joined using an invite link`;
    case 'linked_group_join':
      return `${whom} joined from the community`;
    case 'remove':
      return `${who} removed ${whom}`;
    case 'leave':
      return `${whom} left`;
    case 'promote':
      return `${who} made ${whom} an admin`;
    case 'demote':
      return `${who} dismissed ${whom} as admin`;
    case 'create':
      return `${who} created the group${sys.text ? ` "${sys.text}"` : ''}`;
    case 'subject':
      return `${who} changed the group name${sys.text ? ` to "${sys.text}"` : ''}`;
    case 'description':
      return `${who} changed the group description`;
    case 'picture':
      return `${who} changed the group icon`;
    case 'announce':
      return `${who} changed group settings (who can send messages)`;
    case 'restrict':
      return `${who} changed group settings (who can edit info)`;
    case 'ephemeral':
      return `${who} changed disappearing messages settings`;
    case 'membership_approval_request':
      return `${who} requested to join`;
    case 'change_number':
      return `${who} changed their phone number`;
    default:
      if (sys.text) return sys.text;
      return rawType ? `System notification (${rawType}${sys.subtype ? `/${sys.subtype}` : ''})` : 'System notification';
  }
}
