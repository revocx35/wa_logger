/** Building blocks of the call recorder (recorder.ts): the live audio mixer, IVF framing and the ffmpeg command line. */

export const RATE = 16_000;
const CAP_SAMPLES = RATE; // a source that runs a second ahead of real time loses its oldest audio

/** Samples (s16le) waiting to be mixed in. A source that went quiet is re-primed before it plays again (smooths bursts). */
class Fifo {
  private chunks: Buffer[] = [];
  private offset = 0; // bytes already consumed from chunks[0]
  size = 0; // samples
  private primed = false;

  push(pcm: Buffer): void {
    this.chunks.push(pcm);
    this.size += pcm.length >> 1;
    while (this.size > CAP_SAMPLES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= (dropped.length - this.offset) >> 1;
      this.offset = 0;
    }
  }

  /** Adds up to [n] samples to [into] (silence when empty or not primed yet). */
  mixInto(into: Int32Array, n: number, prime: number): void {
    if (!this.primed) {
      if (this.size < prime) return;
      this.primed = true;
    }
    let i = 0;
    while (i < n && this.chunks.length) {
      const c = this.chunks[0]!;
      while (i < n && this.offset + 1 < c.length) {
        into[i++]! += c.readInt16LE(this.offset);
        this.offset += 2;
        this.size--;
      }
      if (this.offset + 1 >= c.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    if (this.size <= 0) this.primed = false;
  }
}

/**
 * Mixes the other side's voice and ours into one continuous 16 kHz mono stream, driven by the wall clock: [tick] emits as
 * many samples as real time has passed since [t0] (silence where nobody talks, because silence is never sent to us).
 */
export class AudioMixer {
  private readonly peer = new Fifo();
  private readonly own = new Fifo();
  private produced = 0;

  constructor(
    private readonly t0: number,
    private readonly primeSamples = RATE * 0.06,
  ) {}

  push(source: 'peer' | 'own', pcm: Buffer): void {
    (source === 'peer' ? this.peer : this.own).push(pcm);
  }

  /** The samples that are due at [now] (empty when none). */
  tick(now: number): Buffer | null {
    const due = Math.floor(((now - this.t0) * RATE) / 1000) - this.produced;
    if (due <= 0) return null;
    const acc = new Int32Array(due);
    this.peer.mixInto(acc, due, this.primeSamples);
    this.own.mixInto(acc, due, this.primeSamples);
    const out = Buffer.alloc(due * 2);
    for (let i = 0; i < due; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, acc[i]!)), i * 2);
    this.produced += due;
    return out;
  }
}

/* ------------------------------------------------------------------------------------------------------- video */

/** Header of a video message (shared/api.d.ts `CallVideoHello` docs): codec 1 = H.264 Annex B, 2 = VP8. */
export interface VideoFrame {
  codec: number;
  key: boolean;
  /** Quarter turns clockwise to show it upright. */
  rotation: number;
  width: number;
  height: number;
  data: Buffer;
}

export function parseVideoFrame(f: Buffer): VideoFrame | null {
  if (f.length <= 12) return null;
  return { codec: f[0]!, key: (f[1]! & 1) === 1, rotation: f[2]! & 3, width: f.readUInt16LE(4), height: f.readUInt16LE(6), data: f.subarray(12) };
}

export function ivfHeader(width: number, height: number): Buffer {
  const h = Buffer.alloc(32);
  h.write('DKIF', 0, 'ascii');
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(32, 6);
  h.write('H264', 8, 'ascii');
  h.writeUInt16LE(width, 12);
  h.writeUInt16LE(height, 14);
  h.writeUInt32LE(1000, 16); // timebase 1/1000: pts in ms
  h.writeUInt32LE(1, 20);
  return h;
}

export function ivfFrame(ptsMs: number, data: Buffer): Buffer {
  const h = Buffer.alloc(12);
  h.writeUInt32LE(data.length, 0);
  h.writeBigUInt64LE(BigInt(ptsMs), 4);
  return Buffer.concat([h, data]);
}

/** Picture size of the recording: the first frame turned upright, longest side at most 640, even numbers. */
export function canvasFor(width: number, height: number, rotation: number): { w: number; h: number } {
  let w = rotation & 1 ? height : width;
  let h = rotation & 1 ? width : height;
  if (w < 2 || h < 2) {
    w = 640;
    h = 480;
  }
  const f = Math.min(1, 640 / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * f) / 2) * 2);
  return { w: even(w), h: even(h) };
}

const ROTATE = ['', 'transpose=1,', 'hflip,vflip,', 'transpose=2,'];

/**
 * ffmpeg command line: audio on stdin (s16le 16 kHz mono), optionally IVF/H.264 video on fd 3, fragmented MP4 (AAC + H.264) on
 * stdout. Video timestamps are milliseconds since the recording began and audio starts at the same moment (`-copyts`), the
 * picture is padded at the start with the first frame (`fps start_time=0`).
 */
export function ffmpegArgs(video: { w: number; h: number; rotation: number } | null): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-copyts', '-protocol_whitelist', 'pipe', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0'];
  if (video) {
    const { w, h, rotation } = video;
    args.push(
      '-protocol_whitelist', 'pipe', '-f', 'ivf', '-i', 'pipe:3',
      '-filter_complex',
      `[1:v]${ROTATE[rotation & 3]}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=15:start_time=0,format=yuv420p[v]`,
      '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '30',
    );
  } else {
    args.push('-map', '0:a');
  }
  args.push('-c:a', 'aac', '-b:a', '48k', '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof', '-frag_duration', '2000000', 'pipe:1');
  return args;
}

/** One black H.264 key frame (Annex B) of the given size: shown while the other side's camera is off. */
export function blackFrameArgs(w: number, h: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=1`, '-frames:v', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x264-params', 'aud=1:keyint=1', '-f', 'h264', 'pipe:1',
  ];
}
