import { describe, expect, it } from 'vitest';
import { AudioMixer, canvasFor, ffmpegArgs, ivfFrame, ivfHeader, parseVideoFrame, RATE } from './recfmt.js';

const pcm = (values: number[]): Buffer => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
};
const samples = (b: Buffer): number[] => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

describe('AudioMixer', () => {
  it('emits as many samples as the wall clock says, silence when nobody talks', () => {
    const m = new AudioMixer(1000);
    expect(m.tick(1000)).toBeNull();
    expect(m.tick(1100)!.length).toBe(RATE * 0.1 * 2);
    expect(samples(m.tick(1200)!).every((s) => s === 0)).toBe(true);
    // catches up after a stall
    expect(m.tick(2200)!.length).toBe(RATE * 1.0 * 2);
  });

  it('mixes both sides, clamps, and waits for a short prebuffer after silence', () => {
    const m = new AudioMixer(0, 4);
    m.push('peer', pcm([100, 100]));
    // two samples are below the 4-sample prebuffer: still silence
    expect(samples(m.tick(1)!).every((s) => s === 0)).toBe(true);
    m.push('peer', pcm([100, 100, 100, 100]));
    m.push('own', pcm([30000, 30000, 30000, 30000]));
    const out = samples(m.tick(2)!); // 16 samples due
    expect(out.slice(0, 4)).toEqual([30100, 30100, 30100, 30100]);
    m.push('peer', pcm([30000, 30000, 30000, 30000, 30000, 30000]));
    m.push('own', pcm([30000, 30000, 30000, 30000, 30000, 30000]));
    const loud = samples(m.tick(3)!);
    expect(Math.max(...loud)).toBe(32767);
  });

  it('drops audio that runs far ahead of real time', () => {
    const m = new AudioMixer(0, 1);
    for (let i = 0; i < 10; i++) m.push('own', Buffer.alloc(RATE * 2, 1));
    expect(m.tick(1000)!.length).toBe(RATE * 2);
    // only about one second was kept: nothing is left for the next second
    expect(samples(m.tick(2000)!).every((s) => s === 0)).toBe(true);
  });
});

describe('video helpers', () => {
  it('parses the 12-byte header', () => {
    const h = Buffer.alloc(12);
    h[0] = 1;
    h[1] = 1;
    h[2] = 3;
    h.writeUInt16LE(640, 4);
    h.writeUInt16LE(480, 6);
    const f = parseVideoFrame(Buffer.concat([h, Buffer.from([0, 0, 0, 1, 9])]))!;
    expect(f).toMatchObject({ codec: 1, key: true, rotation: 3, width: 640, height: 480 });
    expect(f.data.length).toBe(5);
    expect(parseVideoFrame(h)).toBeNull();
  });

  it('frames IVF with millisecond timestamps', () => {
    const hdr = ivfHeader(640, 480);
    expect(hdr.subarray(0, 4).toString()).toBe('DKIF');
    expect(hdr.subarray(8, 12).toString()).toBe('H264');
    expect(hdr.readUInt32LE(16)).toBe(1000);
    const fr = ivfFrame(1234, Buffer.from([1, 2, 3]));
    expect(fr.readUInt32LE(0)).toBe(3);
    expect(Number(fr.readBigUInt64LE(4))).toBe(1234);
    expect([...fr.subarray(12)]).toEqual([1, 2, 3]);
  });

  it('sizes the picture upright, capped and even', () => {
    expect(canvasFor(640, 480, 0)).toEqual({ w: 640, h: 480 });
    expect(canvasFor(640, 480, 1)).toEqual({ w: 480, h: 640 });
    expect(canvasFor(1920, 1080, 0)).toEqual({ w: 640, h: 360 });
    expect(canvasFor(0, 0, 0)).toEqual({ w: 640, h: 480 });
  });

  it('builds audio-only and video command lines', () => {
    const a = ffmpegArgs(null);
    expect(a).not.toContain('pipe:3');
    expect(a).toContain('aac');
    const v = ffmpegArgs({ w: 480, h: 640, rotation: 1 });
    expect(v).toContain('pipe:3');
    expect(v.join(' ')).toContain('transpose=1,scale=480:640');
    expect(v.join(' ')).toContain('fps=15:start_time=0');
    expect(v.filter((x) => x === '-protocol_whitelist').length).toBe(2);
  });
});
