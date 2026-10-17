import { beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The AudioWorklet global scope, faked: the processor only needs these.
let Processor: any;
beforeAll(async () => {
  const g = globalThis as any;
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class {
    port = { sent: [] as any[], onmessage: null as any, postMessage(d: any) { this.sent.push(d); } };
  };
  g.registerProcessor = (_name: string, cls: any) => (Processor = cls);
  await import('./call-worklet.js');
});

const sine = (hz: number, rate: number, n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * (from + i)) / rate));
const zeroCrossHz = (x: ArrayLike<number>, rate: number) => {
  let zc = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) zc++;
  return zc / 2 / (x.length / rate);
};

describe('call worklet', () => {
  it('turns the microphone into 20 ms frames of 16 kHz PCM', () => {
    const p = new Processor();
    const out = [[new Float32Array(128)]];
    for (let k = 0; k < 150; k++) p.process([[sine(1000, 48000, 128, k * 128)]], out);
    const frames = p.port.sent.map((b: ArrayBuffer) => new Int16Array(b));
    expect(frames.length).toBe(Math.floor((150 * 128) / 3 / 320));
    expect(frames.every((f: Int16Array) => f.length === 320)).toBe(true);
    const all = Float32Array.from(frames.flatMap((f: Int16Array) => Array.from(f, (v) => v / 32768)));
    expect(zeroCrossHz(all, 16000)).toBeCloseTo(1000, -1);
    p.port.sent = [];
    p.port.onmessage({ data: { type: 'mute', muted: true } });
    for (let k = 0; k < 30; k++) p.process([[sine(1000, 48000, 128)]], out);
    expect(p.port.sent).toEqual([]);
  });

  it('plays 16 kHz frames at the context rate after a short prebuffer', () => {
    const p = new Processor();
    const frame = (k: number) => {
      const s = sine(500, 16000, 320, k * 320);
      return Int16Array.from(s, (v) => Math.round(v * 32767)).buffer;
    };
    const render = (n: number) => {
      const res: number[] = [];
      for (let i = 0; i < n; i++) {
        const out = [[new Float32Array(128)]];
        p.process([[]], out);
        res.push(...out[0]![0]!);
      }
      return res;
    };
    p.port.onmessage({ data: frame(0) }); // 20 ms: below the 60 ms prebuffer
    expect(render(4).every((v) => v === 0)).toBe(true);
    for (let k = 1; k < 10; k++) p.port.onmessage({ data: frame(k) });
    const played = render(Math.floor((10 * 320 * 3) / 128) - 4);
    expect(zeroCrossHz(played, 48000)).toBeCloseTo(500, -1);
    expect(Math.max(...played)).toBeGreaterThan(0.45);
    // underrun → silence until a new prebuffer
    expect(render(10).slice(-128).every((v) => v === 0)).toBe(true);
  });

  it('drops a backlog instead of falling behind', () => {
    const p = new Processor();
    for (let k = 0; k < 50; k++) p.port.onmessage({ data: new Int16Array(320).fill(1000).buffer }); // 1 s
    expect(p.queued).toBeLessThanOrEqual(0.3 * 16000);
  });
});
