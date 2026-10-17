import type { CDPSession, Page } from 'puppeteer';
import { WAL_CALL_SOURCE } from './callpage.js';
import { PageOpError } from './walbridge.js';

/** A call model as callpage.ts reports it (`__walCallEvent`). Validated: it comes from the page. */
export interface RawCall {
  id: string;
  state: number | null;
  outgoing: boolean;
  isVideo: boolean;
  isGroup: boolean;
  peer: string | null;
  peerAlt: string | null;
  group: string | null;
  peerBusy: boolean;
  failedReason: string | null;
  logResult: number | null;
  everConnected: boolean;
  userEnded: boolean;
  /** We send video / the other side sends video. */
  selfVideo: boolean;
  peerVideo: boolean;
  removed: boolean;
}

const JID = /^[\w.:-]{1,80}@[a-z.]{1,20}$/i;
const CALL_ID = /^[\w.:-]{1,128}$/;
/** Audio queued for the page beyond this is dropped (it would only add delay): 0.5 s of 16 kHz s16le. */
const MAX_QUEUE_BYTES = 16_000;
const PUMP_MS = 40;
/** Size of the video frame header (callpage.ts sendVideo/videoIn, ARCHITECTURE §4 "Video"). */
export const VIDEO_HEADER = 12;
/** Largest video frame accepted from the page or a client. */
export const VIDEO_MAX_FRAME = 512 * 1024;
/** Video frames waiting for the page; beyond this the queue is dropped and the next key frame awaited. */
const MAX_VIDEO_QUEUE = 20;

/** A valid video frame: known codec, header, size. */
export function validVideoFrame(b: Buffer): boolean {
  return b.length > VIDEO_HEADER && b.length <= VIDEO_MAX_FRAME && (b[0] === 1 || b[0] === 2) && b[3] === 0;
}

const jidOrNull = (v: unknown): string | null => (typeof v === 'string' && JID.test(v) ? v : null);

export function parseRawCall(payload: string): RawCall | null {
  if (payload.length > 4096) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !CALL_ID.test(o.id)) return null;
  const state = typeof o.state === 'number' && Number.isInteger(o.state) && o.state >= 0 && o.state < 100 ? o.state : null;
  const logResult = typeof o.logResult === 'number' && Number.isInteger(o.logResult) ? o.logResult : null;
  return {
    id: o.id,
    state,
    outgoing: o.outgoing === true,
    isVideo: o.isVideo === true,
    isGroup: o.isGroup === true,
    peer: jidOrNull(o.peer),
    peerAlt: jidOrNull(o.peerAlt),
    group: jidOrNull(o.group),
    peerBusy: o.peerBusy === true,
    failedReason: typeof o.failedReason === 'string' ? o.failedReason.slice(0, 40) : null,
    logResult,
    everConnected: o.everConnected === true,
    userEnded: o.userEnded === true,
    selfVideo: o.selfVideo === true,
    peerVideo: o.peerVideo === true,
    removed: o.removed === true,
  };
}

/**
 * Node side of callpage.ts: installs it into the WhatsApp tab (now and at every document start), receives call
 * events and the other side's audio through CDP bindings, and feeds the owner's audio into the page's virtual
 * microphone (batched every 40 ms).
 */
export class CallBridge {
  private cdp: CDPSession | null = null;
  private queue: Buffer[] = [];
  private queued = 0;
  private pumping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly page: Page,
    private readonly handlers: { event(call: RawCall): void; audio(pcm: Buffer): void; video?(frame: Buffer): void; needKey?(): void },
  ) {}

  async attach(): Promise<void> {
    const cdp = await this.page.createCDPSession();
    this.cdp = cdp;
    cdp.on('Runtime.bindingCalled', (e: { name: string; payload: string }) => {
      if (e.name === '__walCallEvent') {
        const call = parseRawCall(e.payload);
        if (call) this.handlers.event(call);
      } else if (e.name === '__walCallVideo') {
        if (typeof e.payload !== 'string' || e.payload.length > VIDEO_MAX_FRAME * 1.4) return;
        const frame = Buffer.from(e.payload, 'base64');
        if (validVideoFrame(frame)) this.handlers.video?.(frame);
      } else if (e.name === '__walCallAudio') {
        if (typeof e.payload !== 'string' || e.payload.length > 16_384) return;
        const pcm = Buffer.from(e.payload, 'base64');
        if (pcm.length >= 2 && pcm.length % 2 === 0) this.handlers.audio(pcm);
      }
    });
    await cdp.send('Page.enable');
    // Binding calls are only reported while the Runtime domain is enabled on this session.
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: '__walCallEvent' });
    await cdp.send('Runtime.addBinding', { name: '__walCallAudio' });
    await cdp.send('Runtime.addBinding', { name: '__walCallVideo' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WAL_CALL_SOURCE });
    await this.page.evaluate(WAL_CALL_SOURCE);
    this.timer = setInterval(() => void this.pump(), PUMP_MS);
    this.timer.unref();
  }

  async detach(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.queued = 0;
    this.vqueue = [];
    const cdp = this.cdp;
    this.cdp = null;
    await cdp?.detach().catch(() => undefined);
  }

  /** Runs `window.__walcall` operation [op]; throws PageOpError with the page's error code. */
  async call<T>(op: string, args: unknown, timeoutMs = 30_000): Promise<T> {
    const r = (await this.race(
      this.page.evaluate(
        (o: string, a: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const c = (window as any).__walcall;
          return c ? c.call(o, a) : { ok: false, code: 'not_ready', error: 'WhatsApp Web is still loading.' };
        },
        op,
        args as never,
      ),
      timeoutMs,
    )) as { ok: true; value: T } | { ok: false; code: string; error: string };
    if (!r.ok) throw new PageOpError(r.code, r.error);
    return r.value;
  }

  /**
   * Runs [op] inside a trusted mouse click on the page's gesture button, so it carries user activation like
   * WhatsApp Web's own call buttons (audio playback and capture need it).
   */
  async gesture<T>(op: string, args: unknown, timeoutMs = 45_000): Promise<T> {
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const selector = await this.page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: string, a: unknown, t: string) => ((window as any).__walcall ? (window as any).__walcall.arm({ op: o, args: a, token: t }) : null),
      op,
      args as never,
      token,
    );
    if (!selector) throw new PageOpError('not_ready', 'WhatsApp Web is still loading.');
    // The click never completes while the tab is hidden (e.g. behind a call popout window): give up after 3 s and
    // run the operation directly (page.evaluate still counts as a user gesture).
    const clicked = await Promise.race([
      this.page.click(selector as string, { delay: 20 }).then(
        () => true,
        () => false,
      ),
      new Promise<false>((r) => setTimeout(() => r(false), 3000)),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!clicked) await this.page.evaluate((t: string) => (window as any).__walcall.runArmed({ token: t }), token);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (await this.page.evaluate((t: string) => (window as any).__walcall.result({ token: t }), token)) as
        | { ok: true; value: T }
        | { ok: false; code: string; error: string }
        | null;
      if (r) {
        if (!r.ok) throw new PageOpError(r.code, r.error);
        return r.value;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new PageOpError('timeout', 'WhatsApp Web did not answer in time.');
  }

  /** The owner's voice for the page's virtual microphone (16 kHz s16le). */
  audioIn(pcm: Buffer): void {
    this.queue.push(pcm);
    this.queued += pcm.length;
    while (this.queued > MAX_QUEUE_BYTES && this.queue.length > 1) this.queued -= this.queue.shift()!.length;
  }

  /** One frame of the owner's camera (header + data) for the page's virtual camera. */
  videoIn(frame: Buffer): void {
    if (this.vwaitKey) {
      if ((frame[1]! & 1) === 0) return;
      this.vwaitKey = false;
    }
    if (this.vqueue.length >= MAX_VIDEO_QUEUE) {
      // The page can't keep up: drop what waits and restart at the next key frame.
      this.vqueue = [];
      this.vwaitKey = true;
      this.handlers.needKey?.();
      if ((frame[1]! & 1) === 0) return;
      this.vwaitKey = false;
    }
    this.vqueue.push(frame);
    void this.pumpVideo();
  }

  private vqueue: Buffer[] = [];
  private vwaitKey = false;
  private vpumping = false;

  private async pumpVideo(): Promise<void> {
    if (this.vpumping) return;
    this.vpumping = true;
    try {
      for (let f = this.vqueue.shift(); f && this.cdp; f = this.vqueue.shift()) {
        const r = (await this.cdp
          .send('Runtime.evaluate', { expression: `window.__walcall?window.__walcall.videoIn(${JSON.stringify(f.toString('base64'))}):0`, returnByValue: true })
          .catch(() => null)) as { result?: { value?: unknown } } | null;
        if (r?.result?.value === -1) this.handlers.needKey?.();
      }
    } finally {
      this.vpumping = false;
    }
  }

  private async pump(): Promise<void> {
    const cdp = this.cdp;
    if (this.pumping || !cdp || this.queued === 0) return;
    const data = Buffer.concat(this.queue);
    this.queue = [];
    this.queued = 0;
    this.pumping = true;
    try {
      await cdp.send('Runtime.evaluate', { expression: `window.__walcall&&window.__walcall.audioIn(${JSON.stringify(data.toString('base64'))})` });
    } catch {
      /* page reloading; audio is best effort */
    } finally {
      this.pumping = false;
    }
  }

  private async race<T>(p: Promise<T>, ms: number): Promise<T | { ok: false; code: string; error: string }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; code: string; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: 'timeout', error: 'WhatsApp Web did not answer in time.' }), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
