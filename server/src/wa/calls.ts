import type { CallEndReason, CallInfo, CallState } from '../../../shared/api.js';
import type { AppContext, CallAudioClient, CallVideoClient, WaCalls } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { parseRawCall, type CallBridge, type RawCall } from './callbridge.js';
import { CallRecorder } from './recorder.js';
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
 * (`WS /api/calls/audio`) while the call is being placed or is connected. Calls are recorded only when the owner asks
 * (record button) or turned on "record calls" (recorder.ts); nothing is logged but outcomes.
 */
export class CallService implements WaCalls {
  private readonly calls = new Map<string, { info: CallInfo; mapped: Mapped | null }>();
  private currentId: string | null = null;
  private audio: CallAudioClient | null = null;
  private bridgeOn = false;
  private videoClient: CallVideoClient | null = null;
  private videoOn = false;
  private lastPeerKeyRequest = 0;
  private readonly started: number[] = [];
  private readonly lastPeerVideo = new Map<string, boolean>();
  private recorder: CallRecorder | null = null;
  private recorderStarting = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly bridge: () => CallBridge | null,
  ) {
    // A recording that was still being written when the app stopped can't be finished: its file was never closed.
    for (const r of ctx.repo.recordingsWithStatus('recording', 'processing')) ctx.repo.updateRecording(r.id, { status: 'failed' });
  }

  available(): boolean {
    return this.bridge() !== null;
  }

  current(): CallInfo | null {
    const c = this.currentId ? this.calls.get(this.currentId) : undefined;
    return c ? this.view(c.info) : null;
  }

  private recording(): boolean {
    return !!this.recorder && !this.recorder.ending;
  }

  private view(info: CallInfo): CallInfo {
    return { ...info, audio: !!this.audio, videoClient: !!this.videoClient, recording: this.recording() };
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
          selfVideo: c.selfVideo,
          peerVideo: c.peerVideo,
          group: c.isGroup,
          chatId: this.chatFor(c),
          startedAt: now,
          connectedAt: null,
          endedAt: null,
          endReason: null,
          audio: false,
          videoClient: false,
          recording: false,
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
    const videoChanged = info.video !== (info.video || c.isVideo) || info.selfVideo !== c.selfVideo || info.peerVideo !== c.peerVideo;
    if (next === info.state && !created && !videoChanged) return;
    if (!info.chatId) info.chatId = this.chatFor(c);
    info.video = info.video || c.isVideo; // an audio call upgraded to video stays a video call
    info.selfVideo = next === 'ended' ? false : c.selfVideo;
    info.peerVideo = next === 'ended' ? false : c.peerVideo;
    info.state = next;
    if (info.peerVideo !== this.lastPeerVideo.get(info.id)) {
      this.lastPeerVideo.set(info.id, info.peerVideo);
      this.recorder?.peerVideoState(info.peerVideo);
    }
    const firstActive = next === 'active' && !info.connectedAt;
    if (firstActive) info.connectedAt = Date.now();
    if (firstActive && this.ctx.settings.get().recordCalls) void this.startRecording(info.id, true).catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'automatic call recording not started'));
    if (next === 'ended') {
      info.endedAt = Date.now();
      info.endReason = endReason(c, info, mapped);
      this.lastPeerVideo.delete(info.id);
      void this.recorder?.stop();
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
    void this.recorder?.stop();
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
    this.ctx.events.emit({ type: 'call', call: this.view(info) });
  }

  /* ----------------------------------------------------------------------------------------- audio */

  /** Audio flows while our call is being placed or is connected and a client listens. */
  private wantBridge(): boolean {
    const c = this.current();
    if (!c || (!this.audio && !this.recorder)) return false;
    return c.state === 'active' || c.state === 'connecting' || (c.direction === 'outgoing' && (c.state === 'calling' || c.state === 'ringing'));
  }

  private syncBridge(): void {
    const c = this.current();
    if (this.audio && (!c || c.state === 'ended')) {
      const a = this.audio;
      this.audio = null;
      a.close(c ? 1000 : 4004, c ? 'Call ended' : 'No call');
    }
    if (this.videoClient && (!c || c.state === 'ended')) {
      const v = this.videoClient;
      this.videoClient = null;
      v.close(c ? 1000 : 4004, c ? 'Call ended' : 'No call');
    }
    const b = this.bridge();
    const want = this.wantBridge();
    if (want !== this.bridgeOn) {
      this.bridgeOn = want;
      if (b) void b.call('setBridge', { on: want }, 10_000).catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'call audio switch failed'));
    }
    // Video flows on the same terms, with a video client attached.
    const wantVideo = !!(c && (this.videoClient || (this.recorder && c.video)) && (c.state === 'active' || c.state === 'connecting' || (c.direction === 'outgoing' && (c.state === 'calling' || c.state === 'ringing'))));
    if (wantVideo !== this.videoOn) {
      this.videoOn = wantVideo;
      if (b) {
        void b
          .call('setVideoBridge', { on: wantVideo }, 10_000)
          .then(() => wantVideo && this.requestPeerKeyFrame())
          .catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'call video switch failed'));
      }
    }
  }

  /** The other side's voice from the page. */
  onPageAudio(pcm: Buffer): void {
    if (!this.bridgeOn) return;
    this.audio?.send(pcm);
    this.recorder?.peerAudio(pcm);
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

  /* ----------------------------------------------------------------------------------------- video */

  /** The other side's video from the page (header + H.264/VP8 frame). */
  onPageVideo(frame: Buffer): void {
    if (!this.videoOn) return;
    this.videoClient?.send(frame);
    this.recorder?.peerVideo(frame);
  }

  /** The page's virtual camera needs a key frame from the owner's camera (decoder (re)started or fell behind). */
  onPageNeedsKey(): void {
    this.videoClient?.requestKeyFrame();
  }

  attachVideo(client: CallVideoClient): (() => void) | null {
    const c = this.current();
    if (!c || c.state === 'ended') return null;
    const prev = this.videoClient;
    this.videoClient = client;
    prev?.close(4000, 'Replaced by another connection');
    this.emit(this.calls.get(c.id)!.info);
    this.syncBridge();
    if (this.videoOn) this.requestPeerKeyFrame();
    client.requestKeyFrame();
    return () => {
      if (this.videoClient !== client) return;
      this.videoClient = null;
      const cur = this.current();
      if (cur && cur.state !== 'ended') this.emit(this.calls.get(cur.id)!.info);
      this.syncBridge();
    };
  }

  /** The owner's camera from the client (header + H.264/VP8 frame). */
  videoIn(client: CallVideoClient, frame: Buffer): void {
    if (this.videoClient !== client || !this.videoOn) return;
    this.bridge()?.videoIn(frame);
  }

  /** The client lost the picture (or just started): ask the other side for a key frame, at most once a second. */
  requestPeerKeyFrame(client?: CallVideoClient): void {
    if (client && client !== this.videoClient) return;
    const now = Date.now();
    if (now - this.lastPeerKeyRequest < 1000) return;
    this.lastPeerKeyRequest = now;
    void this.bridge()?.call('keyframe', {}, 10_000).catch(() => undefined);
  }

  /** The owner's voice from the client (16 kHz s16le). */
  audioIn(client: CallAudioClient, pcm: Buffer): void {
    if (this.audio !== client || !this.bridgeOn) return;
    this.recorder?.ownAudio(pcm);
    this.bridge()?.audioIn(pcm);
  }

  /* -------------------------------------------------------------------------------------- controls */

  private charge(): void {
    const now = Date.now();
    while (this.started.length && this.started[0]! < now - 3600_000) this.started.shift();
    if (this.started.length >= MAX_CALLS_PER_HOUR) throw Errors.rateLimited((this.started[0]! + 3600_000 - now) / 1000);
    this.started.push(now);
  }

  async start(chatId: string, video = false): Promise<CallInfo> {
    const live = this.current();
    if (live && live.state !== 'ended') throw Errors.conflict('There is already a call. End it first.');
    const page = this.page();
    this.charge();
    let raw: unknown;
    try {
      raw = await page.gesture('start', { chatId, video }, 45_000);
    } catch (e) {
      throw callError(e);
    }
    this.ctx.repo.audit('call_started', null, video ? 'video' : null);
    // From the page: validated like the binding events.
    const parsed = raw && typeof raw === 'object' ? parseRawCall(JSON.stringify(raw)) : null;
    if (parsed) this.onCall({ ...parsed, outgoing: true, removed: false });
    const info = parsed ? this.calls.get(parsed.id)?.info : undefined;
    if (!info) throw Errors.unavailable('WhatsApp did not start the call.');
    return this.view(info);
  }

  private known(callId: string): CallInfo {
    const c = this.calls.get(callId)?.info;
    if (!c || c.state === 'ended') throw Errors.notFound('Call');
    return c;
  }

  async accept(callId: string, video = false): Promise<CallInfo> {
    const c = this.known(callId);
    if (c.direction !== 'incoming' || c.state !== 'incoming') throw Errors.conflict('This call is not ringing.');
    try {
      await this.page().gesture('accept', { callId, video }, 45_000);
    } catch (e) {
      throw callError(e);
    }
    this.ctx.repo.audit('call_accepted', null, video ? 'video' : null);
    return this.view(c);
  }

  /** Camera on/off (on in a voice call asks the other side to switch to video, like WhatsApp's camera button). */
  async setVideo(callId: string, on: boolean): Promise<CallInfo> {
    const c = this.known(callId);
    if (c.state === 'incoming') throw Errors.conflict('Answer the call first.');
    let raw: unknown;
    try {
      raw = await this.page().gesture('setVideo', { callId, on }, 30_000);
    } catch (e) {
      throw callError(e);
    }
    const parsed = raw && typeof raw === 'object' ? parseRawCall(JSON.stringify(raw)) : null;
    if (parsed) this.onCall(parsed);
    return this.view(this.calls.get(callId)?.info ?? c);
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

  /* -------------------------------------------------------------------------------------- recording */

  /** Starts recording the call (it must be connected). Idempotent while one is running. */
  async startRecording(callId: string, auto = false): Promise<CallInfo> {
    const c = this.known(callId);
    if (this.recording() || this.recorderStarting) return this.view(c);
    if (c.state !== 'active') throw Errors.conflict('The call is not connected yet.');
    this.recorderStarting = true;
    try {
      const rec = await CallRecorder.start(
        this.ctx,
        { callId, chatId: c.chatId, direction: c.direction, video: c.video || c.peerVideo, auto },
        {
          requestKeyFrame: () => this.requestPeerKeyFrame(),
          onEnd: () => {
            if (this.recorder === rec) this.recorder = null;
            const cur = this.calls.get(callId)?.info;
            if (cur) this.emit(cur);
            this.syncBridge();
          },
        },
      );
      this.recorder = rec;
      if (c.video) rec.peerVideoState(c.peerVideo);
      this.ctx.repo.audit('call_recording_started', null, auto ? 'auto' : 'manual');
    } finally {
      this.recorderStarting = false;
    }
    this.emit(c);
    this.syncBridge();
    return this.view(c);
  }

  async setRecording(callId: string, on: boolean): Promise<CallInfo> {
    return on ? this.startRecording(callId) : this.stopRecording(callId);
  }

  async stopRecording(callId: string): Promise<CallInfo> {
    const c = this.known(callId);
    await this.recorder?.stop();
    return this.view(this.calls.get(callId)?.info ?? c);
  }

  /** Aggregates only (for diagnostics): whether calling can work in the WhatsApp tab. */
  async diagnostics(): Promise<unknown> {
    return this.page().call('diag', {}, 15_000);
  }
}
