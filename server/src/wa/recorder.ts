import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { CallRecordingStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';
import { beginMediaFile, deleteMediaFile, finishMediaFile, type PendingMediaFile } from './media.js';
import { AudioMixer, blackFrameArgs, canvasFor, ffmpegArgs, ivfFrame, ivfHeader, parseVideoFrame } from './recfmt.js';

/** A recording stops by itself after this long or this many bytes (a forgotten call must not fill the disk). */
export const MAX_RECORDING_MS = 6 * 3600_000;
export const MAX_RECORDING_BYTES = 2 * 1024 ** 3;
/** In a video call the file starts once the other side's picture arrives; after this long it is audio only. */
const VIDEO_WAIT_MS = 8000;
/** Frames waiting for ffmpeg beyond this are dropped (it can't keep up: better a choppy picture than a growing queue). */
const MAX_VIDEO_BACKLOG = 4 * 1024 * 1024;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export interface RecorderInit {
  callId: string;
  chatId: string | null;
  direction: 'incoming' | 'outgoing';
  /** The call carries (or will carry) the other side's picture. */
  video: boolean;
  auto: boolean;
}

/** What the owner of a recorder (CallService) provides. */
export interface RecorderHooks {
  /** Asks the other side for a video key frame (the file can only start at one). */
  requestKeyFrame(): void;
  /** The recording is over (finished or failed). */
  onEnd(): void;
}

/** Runs ffmpeg for a short job and returns its stdout (null on any failure). */
function oneShot(args: string[], timeoutMs = 10_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let p: ChildProcess;
    try {
      p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout!.on('data', (d: Buffer) => out.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.length ? Buffer.concat(out) : null);
    });
  });
}

/**
 * Records one call: the other side's voice and ours mixed into one AAC track and, in video calls, the other side's
 * picture, written by ffmpeg as fragmented MP4 straight into an encrypted media file (the app holds only the public key,
 * so recording needs no login and nothing readable ever touches the disk). Both directions come from the call bridge:
 * `peerAudio`/`peerVideo` from the page, `ownAudio` from the client. Nothing is logged but sizes and outcomes.
 */
export class CallRecorder {
  readonly t0 = Date.now();
  private readonly mixer = new AudioMixer(this.t0);
  private proc: ChildProcess | null = null;
  private videoPipe: Writable | null = null;
  private backlog: Buffer[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private waitTimer: NodeJS.Timeout | null = null;
  private blackTimer: NodeJS.Timeout | null = null;
  private keyTimer: NodeJS.Timeout | null = null;
  private black: Buffer | null = null;
  private lastPts = 0;
  private peerVideoActive = true;
  private hasVideo = false;
  private ending_ = false;
  private stopping: Promise<void> | null = null;
  private outDone: Promise<void> = Promise.resolve();
  private stderrTail = '';
  private failed = false;
  private dropped = 0;

  private constructor(
    private readonly ctx: AppContext,
    readonly id: number,
    private readonly file: PendingMediaFile,
    private readonly wantVideo: boolean,
    private readonly hooks: RecorderHooks,
  ) {}

  static async start(ctx: AppContext, init: RecorderInit, hooks: RecorderHooks): Promise<CallRecorder> {
    if (!ctx.writer()) throw Errors.unavailable('Recording needs the account to be set up.');
    const file = await beginMediaFile(ctx);
    const id = ctx.repo.insertRecording({ call_id: init.callId, chat_id: init.chatId, direction: init.direction, video: false, auto: init.auto, started_at: Date.now() });
    const rec = new CallRecorder(ctx, id, file, init.video, hooks);
    rec.tickTimer = setInterval(() => rec.tick(), 20);
    rec.tickTimer.unref();
    if (init.video) {
      rec.waitTimer = setTimeout(() => rec.launch(null), VIDEO_WAIT_MS);
      rec.waitTimer.unref();
      rec.keyTimer = setInterval(() => hooks.requestKeyFrame(), 1500);
      rec.keyTimer.unref();
      hooks.requestKeyFrame();
    } else {
      rec.launch(null);
    }
    ctx.events.emit({ type: 'call_recording', id, status: 'recording' });
    return rec;
  }

  /* --------------------------------------------------------------------------------------------- input */

  peerAudio(pcm: Buffer): void {
    this.mixer.push('peer', pcm);
  }

  ownAudio(pcm: Buffer): void {
    this.mixer.push('own', pcm);
  }

  /** A frame of the other side's video (12-byte header + H.264 Annex B; VP8 is not recorded). */
  peerVideo(frame: Buffer): void {
    if (!this.wantVideo || this.ending_) return;
    const f = parseVideoFrame(frame);
    if (!f || f.codec !== 1) return;
    if (!this.videoPipe) {
      // First picture: now the size and orientation are known (after the wait ran out the file is audio only).
      if (this.proc || !f.key) return;
      this.launch({ ...canvasFor(f.width, f.height, f.rotation), rotation: f.rotation, srcW: f.width, srcH: f.height });
    }
    if (!this.videoPipe) return;
    this.peerVideoActive = true;
    this.writeVideo(f.data);
  }

  /** The other side's camera went on or off: while it is off the recording shows black instead of the last picture. */
  peerVideoState(on: boolean): void {
    this.peerVideoActive = on;
    if (on && this.blackTimer) {
      clearInterval(this.blackTimer);
      this.blackTimer = null;
    }
    if (!on && this.videoPipe && this.black && !this.blackTimer) {
      const black = this.black;
      this.blackTimer = setInterval(() => {
        if (!this.peerVideoActive) this.writeVideo(black);
      }, 1000);
      this.blackTimer.unref();
    }
  }

  /* ----------------------------------------------------------------------------------------- ffmpeg */

  private writeVideo(au: Buffer): void {
    const pipe = this.videoPipe;
    if (!pipe || pipe.destroyed) return;
    if (pipe.writableLength > MAX_VIDEO_BACKLOG) {
      this.dropped++;
      return;
    }
    this.lastPts = Math.max(this.lastPts + 1, Date.now() - this.t0);
    pipe.write(ivfFrame(this.lastPts, au));
  }

  private launch(video: { w: number; h: number; rotation: number; srcW: number; srcH: number } | null): void {
    if (this.proc || this.ending_) return;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    if (this.keyTimer) clearInterval(this.keyTimer);
    this.keyTimer = null;
    let p: ChildProcess;
    try {
      p = spawn(FFMPEG, ffmpegArgs(video), { stdio: ['pipe', 'pipe', 'pipe', ...(video ? ['pipe' as const] : [])] });
    } catch (e) {
      this.fail(`spawn: ${(e as Error).message}`);
      return;
    }
    this.proc = p;
    this.hasVideo = !!video;
    p.on('error', (e) => this.fail(`ffmpeg: ${e.message}`));
    p.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('latin1')).slice(-400);
    });
    p.stdin!.on('error', () => undefined);
    p.on('close', (code) => {
      if (!this.stopping && !this.failed) this.fail(`ffmpeg exited with ${code}`);
    });
    this.outDone = this.pumpOutput(p);
    if (video) {
      this.videoPipe = p.stdio[3] as Writable;
      this.videoPipe.on('error', () => undefined);
      this.videoPipe.write(ivfHeader(video.srcW, video.srcH));
      void oneShot(blackFrameArgs(video.srcW, video.srcH)).then((b) => {
        this.black = b;
        if (!this.peerVideoActive) this.peerVideoState(false);
      });
    }
    // Everything mixed so far (the call was recorded before the picture arrived) goes in first.
    for (const b of this.backlog) p.stdin!.write(b);
    this.backlog = [];
  }

  private async pumpOutput(p: ChildProcess): Promise<void> {
    try {
      for await (const chunk of p.stdout!) {
        await this.file.writer.write(chunk as Buffer);
        if (this.file.writer.bytesWritten > MAX_RECORDING_BYTES) void this.stop();
      }
    } catch (e) {
      this.fail(`write: ${(e as Error).message}`);
    }
  }

  private tick(): void {
    if (this.ending_) return;
    const pcm = this.mixer.tick(Date.now());
    if (pcm) {
      if (this.proc?.stdin && !this.proc.stdin.destroyed) this.proc.stdin.write(pcm);
      else if (!this.proc) this.backlog.push(pcm);
    }
    if (Date.now() - this.t0 > MAX_RECORDING_MS) void this.stop();
  }

  /* ------------------------------------------------------------------------------------------- finish */

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.ctx.log.warn({ reason, tail: this.stderrTail.replace(/\s+/g, ' ').trim() }, 'call recording failed');
    void this.stop();
  }

  /** Stopping or already stopped (the file is being finished). */
  get ending(): boolean {
    return this.ending_;
  }

  /** Ends the recording and finalizes the file. Safe to call more than once. */
  stop(): Promise<void> {
    if (!this.stopping) {
      // A video call that ends before the picture arrived becomes an audio-only file.
      if (!this.proc && !this.failed) this.launch(null);
      this.ending_ = true;
      this.stopping = this.finish();
    }
    return this.stopping;
  }

  private async finish(): Promise<void> {
    for (const t of [this.tickTimer, this.waitTimer, this.blackTimer, this.keyTimer]) if (t) clearTimeout(t);
    this.tickTimer = this.waitTimer = this.blackTimer = this.keyTimer = null;
    const ended = Date.now();
    const { ctx, id } = this;
    let status: CallRecordingStatus = 'processing';
    ctx.repo.updateRecording(id, { status, ended_at: ended, duration_ms: ended - this.t0, video: this.hasVideo ? 1 : 0 });
    ctx.events.emit({ type: 'call_recording', id, status });
    try {
      const p = this.proc;
      if (!p || this.failed) throw new Error('failed');
      const tail = this.mixer.tick(ended);
      if (tail && !p.stdin!.destroyed) p.stdin!.write(tail);
      p.stdin!.end();
      this.videoPipe?.end();
      await this.within(this.outDone, 60_000, () => p.kill('SIGKILL'));
      if (this.failed) throw new Error('failed');
      const done = await finishMediaFile(ctx, this.file, 'recording', this.hasVideo ? 'video/mp4' : 'audio/mp4', `call-${id}.mp4`);
      ctx.repo.updateRecording(id, { status: 'ready', media_id: done.mediaId });
      status = 'ready';
    } catch {
      status = 'failed';
      this.proc?.kill('SIGKILL');
      await this.file.writer.abort().catch(() => undefined);
      await deleteMediaFile(ctx, this.file.relPath).catch(() => undefined);
      ctx.repo.updateRecording(id, { status: 'failed' });
    }
    ctx.log.info({ status, seconds: Math.round((ended - this.t0) / 1000), video: this.hasVideo, droppedVideoFrames: this.dropped }, 'call recording');
    ctx.events.emit({ type: 'call_recording', id, status });
    this.hooks.onEnd();
  }

  private async within(p: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(() => (onTimeout(), r()), ms)))]);
    clearTimeout(timer);
  }
}
