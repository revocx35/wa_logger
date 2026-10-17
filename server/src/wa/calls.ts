import type { CallEndReason, CallInfo, CallState } from '../../../shared/api.js';
import type { AppContext, CallAudioClient, WaCalls } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { parseRawCall, type CallBridge, type RawCall } from './callbridge.js';
import { toAppError } from './sender.js';
import { PageOpError } from './walbridge.js';

/** Calls placed per rolling hour: a stolen session must not get the account banned. */
const MAX_CALLS_PER_HOUR = 30;
/** How long an ended call stays the "current" one (so late clients still see how it ended). */
const ENDED_LINGER_MS = 15_000;

type Mapped = CallState | 'elsewhere';

/** WhatsApp Web's CallState (WAWebVoipWaCallEnums, see docs/wwebjs-notes.md "Calls") → ours. null: unknown, ignore. */
export function mapCallState(raw: number | null): Mapped | null {
  switch (raw) {
    case 1: // Calling
    case 12: // PreCalling
    case 14: // CallBCallStarting
      return 'calling';
    case 2: // PreacceptReceived: a device of the other side rings
      return 'ringing';
    case 3: // ReceivedCall
    case 8: // ReceivedCallWithoutOffer
      return 'incoming';
    case 4: // AcceptSent
    case 5: // AcceptReceived
    case 9: // Rejoining
    case 10: // Link
      return 'connecting';
    case 6: // CallActive
    case 11: // ConnectedLonely
      return 'active';
    case 7: // CallActiveElseWhere
      return 'elsewhere';
    case 0: // None
    case 13: // CallStateEnding
      return 'ended';
    default:
      return null;
  }
}

/** Why a call ended, from the model's last snapshot (callLogResult: 1 connected, 2 missed, 3 declined, 4 canceled, 5 unavailable, 6 elsewhere). */
export function endReason(c: RawCall, info: CallInfo, mapped: Mapped | null): CallEndReason {
  if (mapped === 'elsewhere' || c.logResult === 6) return 'elsewhere';
  if (c.peerBusy) return 'busy';
  if (info.connectedAt || c.everConnected || c.logResult === 1) return 'completed';
  switch (c.logResult) {
    case 2:
    case 7:
      return 'missed';
    case 3:
      return 'declined';
    case 4:
      return 'canceled';
    case 5:
      return 'unavailable';
  }
  if (c.failedReason) return 'failed';
  if (info.direction === 'incoming') return c.userEnded ? 'declined' : 'missed';
  return c.userEnded ? 'canceled' : 'unavailable';
}

/** Page error codes (callpage.ts fail()) → API errors; the page's messages are written to be shown. */
function callError(e: unknown): AppError {
  if (e instanceof PageOpError) {
    if (e.code === 'busy') return Errors.conflict(e.message);
    if (e.code === 'unsupported') return new AppError(409, 'calls_unsupported', e.message);
    if (e.code === 'failed') return new AppError(502, 'call_failed', e.message);
  }
  return toAppError(e);
}

const LIVE: ReadonlySet<CallState> = new Set(['incoming', 'calling', 'ringing', 'connecting', 'active']);

/**
 * Voice calls of the linked account, through WhatsApp Web's own calling (callpage.ts in the page, callbridge.ts over
 * CDP). One call at a time, like WhatsApp Web itself. The audio of the current call is bridged to one client
 * (`WS /api/calls/audio`) while the call is being placed or is connected. Nothing is recorded or logged.
 */
export class CallService implements WaCalls {
  private readonly calls = new Map<string, { info: CallInfo; mapped: Mapped | null }>();
  private currentId: string | null = null;
  private audio: CallAudioClient | null = null;
  private bridgeOn = false;
  private readonly started: number[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly bridge: () => CallBridge | null,
  ) {}

  available(): boolean {
    return this.bridge() !== null;
  }

  current(): CallInfo | null {
    const c = this.currentId ? this.calls.get(this.currentId) : undefined;
    return c ? { ...c.info, audio: !!this.audio } : null;
  }

  private page(): CallBridge {
    const b = this.bridge();
    if (!b) throw Errors.unavailable('WhatsApp is not connected.');
    return b;
  }

  /* ----------------------------------------------------------------------------------- page events */

  /** A call model changed in WhatsApp Web. */
  onCall(c: RawCall): void {
    const mapped = c.removed ? 'ended' : mapCallState(c.state);
    let rec = this.calls.get(c.id);
    let created = false;
    if (!rec) {
      // Only calls we see alive are tracked (a model can show up in a terminal state, e.g. history).
      if (!mapped || mapped === 'ended' || mapped === 'elsewhere') return;
      const now = Date.now();
      rec = {
        mapped,
        info: {
          id: c.id,
          direction: c.outgoing ? 'outgoing' : 'incoming',
          state: mapped,
          video: c.isVideo,
          group: c.isGroup,
          chatId: this.chatFor(c),
          startedAt: now,
          connectedAt: null,
          endedAt: null,
          endReason: null,
          audio: false,
        },
      };
      this.calls.set(c.id, rec);
      created = true;
      if (!this.currentId || !LIVE.has(this.calls.get(this.currentId)?.info.state ?? 'ended')) this.currentId = c.id;
      this.ctx.log.info({ direction: rec.info.direction, video: c.isVideo, group: c.isGroup }, 'call');
    }
    const info = rec.info;
    if (info.state === 'ended' || !mapped) return;
    rec.mapped = mapped;
    let next: CallState = mapped === 'elsewhere' ? 'ended' : mapped;
    // WhatsApp briefly reports the setup states again after connecting; don't go back.
    if (info.connectedAt && next !== 'ended' && next !== 'active') next = 'active';
    if (next === info.state && !created) return;
    if (!info.chatId) info.chatId = this.chatFor(c);
    info.state = next;
    if (next === 'active' && !info.connectedAt) info.connectedAt = Date.now();
    if (next === 'ended') {
      info.endedAt = Date.now();
      info.endReason = endReason(c, info, mapped);
      this.ctx.log.info({ reason: info.endReason, seconds: info.connectedAt ? Math.round((info.endedAt - info.connectedAt) / 1000) : 0 }, 'call ended');
      const id = c.id;
      setTimeout(() => {
        this.calls.delete(id);
        if (this.currentId === id) this.currentId = this.latestLive();
      }, ENDED_LINGER_MS).unref();
      if (this.currentId === id) {
        const other = this.latestLive();
        if (other) this.currentId = other;
      }
    }
    this.emit(info);
    this.syncBridge();
  }

  /** WhatsApp disconnected or its tab is gone: whatever was going on is over. */
  onPageLost(): void {
    for (const rec of this.calls.values()) {
      if (rec.info.state === 'ended') continue;
      rec.info.state = 'ended';
      rec.info.endedAt = Date.now();
      rec.info.endReason = rec.info.connectedAt ? 'completed' : 'failed';
      this.emit(rec.info);
    }
    this.syncBridge();
  }

  private latestLive(): string | null {
    let best: CallInfo | null = null;
    for (const { info } of this.calls.values()) if (LIVE.has(info.state) && (!best || info.startedAt > best.startedAt)) best = info;
    return best?.id ?? null;
  }

  /** The chat to show for a call: the one we already log (LID or phone-number id), else the peer's id. */
  private chatFor(c: RawCall): string | null {
    if (c.isGroup && c.group) return c.group;
    for (const id of [c.peer, c.peerAlt]) if (id && this.ctx.repo.getChat(id)) return id;
    return c.peer ?? c.peerAlt;
  }

  private emit(info: CallInfo): void {
    this.ctx.events.emit({ type: 'call', call: { ...info, audio: !!this.audio } });
  }

  /* ----------------------------------------------------------------------------------------- audio */

  /** Audio flows while our call is being placed or is connected and a client listens. */
  private wantBridge(): boolean {
    const c = this.current();
    if (!c || !this.audio) return false;
    return c.state === 'active' || c.state === 'connecting' || (c.direction === 'outgoing' && (c.state === 'calling' || c.state === 'ringing'));
  }

  private syncBridge(): void {
    const c = this.current();
    if (this.audio && (!c || c.state === 'ended')) {
      const a = this.audio;
      this.audio = null;
      a.close(c ? 1000 : 4004, c ? 'Call ended' : 'No call');
    }
    const want = this.wantBridge();
    if (want === this.bridgeOn) return;
    this.bridgeOn = want;
    const b = this.bridge();
    if (b) void b.call('setBridge', { on: want }, 10_000).catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'call audio switch failed'));
  }

  /** The other side's voice from the page. */
  onPageAudio(pcm: Buffer): void {
    if (this.bridgeOn) this.audio?.send(pcm);
  }

  attachAudio(client: CallAudioClient): (() => void) | null {
    const c = this.current();
    if (!c || c.state === 'ended') return null;
    const prev = this.audio;
    this.audio = client;
    prev?.close(4000, 'Replaced by another connection');
    this.emit(this.calls.get(c.id)!.info);
    this.syncBridge();
    return () => {
      if (this.audio !== client) return;
      this.audio = null;
      const cur = this.current();
      if (cur && cur.state !== 'ended') this.emit(this.calls.get(cur.id)!.info);
      this.syncBridge();
    };
  }

  /** The owner's voice from the client (16 kHz s16le). */
  audioIn(client: CallAudioClient, pcm: Buffer): void {
    if (this.audio !== client || !this.bridgeOn) return;
    this.bridge()?.audioIn(pcm);
  }

  /* -------------------------------------------------------------------------------------- controls */

  private charge(): void {
    const now = Date.now();
    while (this.started.length && this.started[0]! < now - 3600_000) this.started.shift();
    if (this.started.length >= MAX_CALLS_PER_HOUR) throw Errors.rateLimited((this.started[0]! + 3600_000 - now) / 1000);
    this.started.push(now);
  }

  async start(chatId: string): Promise<CallInfo> {
    const live = this.current();
    if (live && live.state !== 'ended') throw Errors.conflict('There is already a call. End it first.');
    const page = this.page();
    this.charge();
    let raw: unknown;
    try {
      raw = await page.gesture('start', { chatId }, 45_000);
    } catch (e) {
      throw callError(e);
    }
    this.ctx.repo.audit('call_started', null);
    // From the page: validated like the binding events.
    const parsed = raw && typeof raw === 'object' ? parseRawCall(JSON.stringify(raw)) : null;
    if (parsed) this.onCall({ ...parsed, outgoing: true, removed: false });
    const info = parsed ? this.calls.get(parsed.id)?.info : undefined;
    if (!info) throw Errors.unavailable('WhatsApp did not start the call.');
    return { ...info, audio: !!this.audio };
  }

  private known(callId: string): CallInfo {
    const c = this.calls.get(callId)?.info;
    if (!c || c.state === 'ended') throw Errors.notFound('Call');
    return c;
  }

  async accept(callId: string): Promise<CallInfo> {
    const c = this.known(callId);
    if (c.direction !== 'incoming' || c.state !== 'incoming') throw Errors.conflict('This call is not ringing.');
    try {
      await this.page().gesture('accept', { callId }, 45_000);
    } catch (e) {
      throw callError(e);
    }
    this.ctx.repo.audit('call_accepted', null);
    return { ...c, audio: !!this.audio };
  }

  async reject(callId: string): Promise<void> {
    const c = this.known(callId);
    if (c.state !== 'incoming') throw Errors.conflict('This call is not ringing.');
    try {
      await this.page().call('reject', { callId }, 20_000);
    } catch (e) {
      throw callError(e);
    }
    this.ctx.repo.audit('call_declined', null);
  }

  async hangup(callId: string): Promise<void> {
    this.known(callId);
    try {
      await this.page().call('hangup', { callId }, 20_000);
    } catch (e) {
      throw callError(e);
    }
  }

  /** Aggregates only (for diagnostics): whether calling can work in the WhatsApp tab. */
  async diagnostics(): Promise<unknown> {
    return this.page().call('diag', {}, 15_000);
  }
}
