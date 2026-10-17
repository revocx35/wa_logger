import type { CallVideoHello } from '../../../shared/api';

/** Frame header of `WS /api/calls/video` (shared/api.d.ts): codec, flags, rotation, 0, width, height, timestamp. */
const VH = 12;
const CODEC_H264 = 1;
const CODEC_VP8 = 2;
const FPS = 24;
const KEY_EVERY_MS = 3000;

export type CallVideoEnd = 'ended' | 'replaced' | 'session' | 'error';

/** Whether this browser can do video calls at all (WebCodecs; the camera needs HTTPS). */
export function videoSupported(): boolean {
  return window.isSecureContext && typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * The browser end of a call's video: camera → VideoEncoder (VP8, or H.264 where VP8 can't be encoded) →
 * `WS /api/calls/video` → WhatsApp, and the other side's frames → VideoDecoder → a canvas. The camera runs only
 * while it is switched on. Nothing is recorded.
 */
export class CallVideo {
  private ws: WebSocket | null = null;
  private stopped = false;
  private camera: MediaStream | null = null;
  private source: HTMLVideoElement | null = null;
  private encoder: VideoEncoder | null = null;
  private encCodec = CODEC_VP8;
  private encW = 0;
  private encH = 0;
  private wantKey = true;
  private lastKey = 0;
  private timer: number | null = null;
  private t0 = performance.now();
  private decoder: VideoDecoder | null = null;
  private decCodec = 0;
  private needKey = true;
  private rotation = 0;
  private canvas: HTMLCanvasElement | null = null;
  /** The last remote frame size (for the UI's aspect ratio). */
  remoteSize: { w: number; h: number } | null = null;

  constructor(
    private readonly onEnd: (why: CallVideoEnd, detail?: string) => void,
    private readonly onRemote: (size: { w: number; h: number } | null) => void = () => undefined,
  ) {}

  /** Where the other side's video is drawn. */
  setCanvas(c: HTMLCanvasElement | null): void {
    this.canvas = c;
  }

  get cameraStream(): MediaStream | null {
    return this.camera;
  }

  async connect(): Promise<void> {
    if (this.stopped || this.ws) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/calls/video`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as CallVideoHello | { type: 'keyframe' };
        if (m.type === 'keyframe') this.wantKey = true;
        return;
      }
      this.receive(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 1000 || e.code === 4004) this.end('ended');
      else if (e.code === 4000) this.end('replaced');
      else if (e.code === 4001) this.end('session');
      else this.end('error', 'The video connection was lost.');
    };
  }

  /* ------------------------------------------------------------------------------------------ camera */

  /** Turns the camera on (asks for permission the first time). Rejects with a message to show. */
  async startCamera(): Promise<MediaStream> {
    if (this.camera) return this.camera;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: FPS } } });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new Error(name === 'NotAllowedError' || name === 'SecurityError' ? 'The browser blocked the camera. Allow it for this site and try again.' : 'No camera was found.');
    }
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('The call is over.');
    }
    this.camera = stream;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play().catch(() => undefined);
    this.source = v;
    this.wantKey = true;
    this.timer = window.setInterval(() => this.capture(), 1000 / FPS);
    return stream;
  }

  stopCamera(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.camera?.getTracks().forEach((t) => t.stop());
    this.camera = null;
    if (this.source) this.source.srcObject = null;
    this.source = null;
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* closed */
    }
    this.encoder = null;
  }

  private async makeEncoder(w: number, h: number): Promise<void> {
    const base = { width: w, height: h, bitrate: 800_000, framerate: FPS, latencyMode: 'realtime' as const };
    const vp8 = { codec: 'vp8', ...base };
    const avc = { codec: 'avc1.42001f', avc: { format: 'annexb' as const }, ...base };
    const useVp8 = (await VideoEncoder.isConfigSupported(vp8).catch(() => ({ supported: false }))).supported;
    const enc = new VideoEncoder({
      output: (chunk) => this.sendChunk(chunk),
      error: () => {
        this.encoder = null;
      },
    });
    enc.configure(useVp8 ? vp8 : avc);
    this.encCodec = useVp8 ? CODEC_VP8 : CODEC_H264;
    this.encoder = enc;
    this.encW = w;
    this.encH = h;
    this.wantKey = true;
  }

  private creating = false;
  private scaled: HTMLCanvasElement | null = null;

  private capture(): void {
    const v = this.source;
    const ws = this.ws;
    if (!v || !ws || ws.readyState !== WebSocket.OPEN || v.videoWidth === 0 || this.creating) return;
    // Even dimensions (H.264), at most 640 wide.
    const scale = Math.min(1, 640 / v.videoWidth);
    const w = Math.round((v.videoWidth * scale) / 2) * 2;
    const h = Math.round((v.videoHeight * scale) / 2) * 2;
    if (!this.encoder || this.encoder.state === 'closed' || this.encW !== w || this.encH !== h) {
      this.creating = true;
      void this.makeEncoder(w, h).finally(() => (this.creating = false));
      return;
    }
    if (this.encoder.encodeQueueSize > 2 || ws.bufferedAmount > 512 * 1024) return; // falling behind: skip a frame
    const now = performance.now();
    const key = this.wantKey || now - this.lastKey > KEY_EVERY_MS;
    // Scaled through a canvas: encoders don't all scale input frames to the configured size.
    const sc = (this.scaled ??= document.createElement('canvas'));
    if (sc.width !== w || sc.height !== h) {
      sc.width = w;
      sc.height = h;
    }
    let frame: VideoFrame;
    try {
      sc.getContext('2d')?.drawImage(v, 0, 0, w, h);
      frame = new VideoFrame(sc, { timestamp: Math.round((now - this.t0) * 1000) });
    } catch {
      return;
    }
    try {
      this.encoder.encode(frame, { keyFrame: key });
      if (key) {
        this.wantKey = false;
        this.lastKey = now;
      }
    } finally {
      frame.close();
    }
  }

  private sendChunk(chunk: EncodedVideoChunk): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(VH + chunk.byteLength);
    const dv = new DataView(buf.buffer);
    buf[0] = this.encCodec;
    buf[1] = chunk.type === 'key' ? 1 : 0;
    dv.setUint16(4, this.encW, true);
    dv.setUint16(6, this.encH, true);
    dv.setUint32(8, Math.floor(chunk.timestamp / 1000) >>> 0, true);
    chunk.copyTo(buf.subarray(VH));
    ws.send(buf);
  }

  /* ------------------------------------------------------------------------------------- the other side */

  private requestKey(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'keyframe' }));
  }

  private receive(data: ArrayBuffer): void {
    if (data.byteLength <= VH) return;
    const b = new Uint8Array(data);
    const dv = new DataView(data);
    const codec = b[0]!;
    const key = (b[1]! & 1) === 1;
    if (codec !== CODEC_H264 && codec !== CODEC_VP8) return;
    if (!this.decoder || this.decoder.state === 'closed' || this.decCodec !== codec) {
      try {
        if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      } catch {
        /* closed */
      }
      this.decoder = new VideoDecoder({
        output: (f) => this.draw(f),
        error: () => {
          this.decoder = null;
          this.needKey = true;
          this.requestKey();
        },
      });
      this.decoder.configure({ codec: codec === CODEC_H264 ? 'avc1.42001f' : 'vp8', optimizeForLatency: true });
      this.decCodec = codec;
      this.needKey = true;
    }
    if (this.needKey && !key) {
      this.requestKey();
      return;
    }
    if (this.decoder.decodeQueueSize > 8) {
      // too far behind: start over at the next key frame
      this.decoder.reset();
      this.decoder.configure({ codec: codec === CODEC_H264 ? 'avc1.42001f' : 'vp8', optimizeForLatency: true });
      this.needKey = true;
      this.requestKey();
      return;
    }
    this.needKey = false;
    this.rotation = b[2]! & 3;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: dv.getUint32(8, true) * 1000, data: b.subarray(VH) }));
    } catch {
      this.needKey = true;
      this.requestKey();
    }
  }

  private draw(frame: VideoFrame): void {
    try {
      const c = this.canvas;
      if (!c) return;
      const rot = this.rotation;
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      const cw = rot % 2 ? h : w;
      const ch = rot % 2 ? w : h;
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
      if (!this.remoteSize || this.remoteSize.w !== cw || this.remoteSize.h !== ch) {
        this.remoteSize = { w: cw, h: ch };
        this.onRemote(this.remoteSize);
      }
      const g = c.getContext('2d');
      if (!g) return;
      g.save();
      g.translate(cw / 2, ch / 2);
      g.rotate((Math.PI / 2) * rot);
      g.drawImage(frame, -w / 2, -h / 2, w, h);
      g.restore();
    } finally {
      frame.close();
    }
  }

  private end(why: CallVideoEnd, detail?: string): void {
    if (this.stopped) return;
    this.stop();
    this.onEnd(why, detail);
  }

  /** Releases the camera and closes everything (no callback). */
  stop(): void {
    this.stopped = true;
    this.stopCamera();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* ignore */
    }
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      /* closed */
    }
    this.decoder = null;
  }
}
