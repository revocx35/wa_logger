import type { CallAudioHello } from '../../../shared/api';

/** Why the call audio stopped, shown to the user. */
export type CallAudioEnd = 'ended' | 'replaced' | 'session' | 'error';

/**
 * The browser end of a call: microphone → AudioWorklet (16 kHz frames) → `WS /api/calls/audio` → WhatsApp, and the
 * other side's voice back the same way into the speakers. Construct it inside the click that starts or answers the
 * call (browsers only start audio after a user gesture), then `connect()` once the server knows the call.
 */
export class CallAudio {
  private readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;
  private muted = false;
  private stopped = false;
  private readonly ready: Promise<void>;

  constructor(private readonly onEnd: (why: CallAudioEnd, detail?: string) => void) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Calls need the microphone, which browsers only allow on HTTPS pages. Open wa_logger over HTTPS.');
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    void this.ctx.resume().catch(() => undefined);
    this.ready = this.setup();
    this.ready.catch(() => undefined);
  }

  private async setup(): Promise<void> {
    await this.ctx.audioWorklet.addModule(new URL('./call-worklet.js', import.meta.url).href);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new Error(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'The browser blocked the microphone. Allow it for this site and try again.'
          : 'No microphone was found.',
      );
    }
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const node = new AudioWorkletNode(this.ctx, 'wal-call', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node = node;
    this.ctx.createMediaStreamSource(stream).connect(node);
    node.connect(this.ctx.destination);
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN && !this.muted && ws.bufferedAmount < 64 * 1024) ws.send(e.data);
    };
  }

  /** Microphone and audio graph are ready (rejects with a message to show). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Connects to the server's call audio (after the call was started or answered). */
  async connect(): Promise<void> {
    await this.ready;
    if (this.stopped || this.ws) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/calls/audio`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === 'string') {
        const hello = JSON.parse(e.data) as CallAudioHello;
        if (hello.sampleRate !== 16000) this.end('error', 'Unsupported audio format.');
        return;
      }
      this.node?.port.postMessage(e.data, [e.data]);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 1000 || e.code === 4004) this.end('ended');
      else if (e.code === 4000) this.end('replaced');
      else if (e.code === 4001) this.end('session');
      else this.end('error', 'The call audio connection was lost.');
    };
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.node?.port.postMessage({ type: 'mute', muted: m });
  }

  private end(why: CallAudioEnd, detail?: string): void {
    if (this.stopped) return;
    this.stop();
    this.onEnd(why, detail);
  }

  /** Releases the microphone and closes everything (no callback). */
  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    void this.ctx.close().catch(() => undefined);
  }
}

/** Ringtone (incoming) and ringback (outgoing) beeps, made with Web Audio. Silent if the browser blocks audio. */
export class Tone {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;

  start(kind: 'ring' | 'ringback'): void {
    this.stop();
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    void ctx.resume().catch(() => undefined);
    const beep = () => {
      if (ctx.state !== 'running') return;
      const t0 = ctx.currentTime;
      const g = ctx.createGain();
      g.connect(ctx.destination);
      const freqs = kind === 'ring' ? [440, 480] : [425];
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(g);
        o.start(t0);
        o.stop(t0 + 1);
      }
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(kind === 'ring' ? 0.12 : 0.06, t0 + 0.02);
      g.gain.setValueAtTime(kind === 'ring' ? 0.12 : 0.06, t0 + 0.95);
      g.gain.linearRampToValueAtTime(0, t0 + 1);
    };
    beep();
    this.timer = window.setInterval(beep, kind === 'ring' ? 3000 : 4000);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
