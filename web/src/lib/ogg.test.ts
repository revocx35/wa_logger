import { describe, expect, it } from 'vitest';
import { oggOpus, opusPacketSamples, parseWebmOpus, webmToOgg } from './ogg';

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => {
  const arr = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arr.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of arr) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** EBML element with a 1- or 2-byte (or unknown 8-byte) size. */
const size = (n: number) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);
const el = (id: number[], body: Uint8Array, unknown = false) => cat(id, unknown ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : size(body.length), body);

function webm(packets: Uint8Array[]): Uint8Array {
  const head = cat(enc('OpusHead'), [1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
  const track = el([0xae], cat(el([0x86], enc('A_OPUS')), el([0x63, 0xa2], head)));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], track);
  const blocks = packets.map((p, i) => el([0xa3], cat([0x81, (i >> 8) & 0xff, i & 0xff, 0x80], p)));
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], cat(el([0xe7], Uint8Array.of(0)), ...blocks), true);
  return cat(el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], enc('webm'))), el([0x18, 0x53, 0x80, 0x67], cat(tracks, cluster), true));
}

function readPages(ogg: Uint8Array) {
  const pages: { flags: number; granule: bigint; seq: number; packets: Uint8Array[] }[] = [];
  let off = 0;
  while (off < ogg.length) {
    expect(new TextDecoder().decode(ogg.subarray(off, off + 4))).toBe('OggS');
    const v = new DataView(ogg.buffer, ogg.byteOffset + off);
    const nseg = ogg[off + 26]!;
    const lacing = ogg.subarray(off + 27, off + 27 + nseg);
    let p = off + 27 + nseg;
    const packets: Uint8Array[] = [];
    let cur = 0;
    let start = p;
    for (const l of lacing) {
      cur += l;
      if (l < 255) {
        packets.push(ogg.slice(start, start + cur));
        start += cur;
        cur = 0;
      }
    }
    p = start;
    pages.push({ flags: ogg[off + 5]!, granule: v.getBigUint64(6, true), seq: v.getUint32(18, true), packets });
    off = p;
  }
  return pages;
}

describe('ogg', () => {
  it('counts Opus samples from the TOC byte', () => {
    expect(opusPacketSamples(Uint8Array.of(0xfc))).toBe(960); // CELT FB 20 ms, 1 frame
    expect(opusPacketSamples(Uint8Array.of(0x09))).toBe(960 * 2); // SILK 20 ms, code 1: 2 frames
    expect(opusPacketSamples(Uint8Array.of(0x13, 0x03))).toBe(1920 * 3); // SILK 40 ms, code 3: 3 frames
    expect(opusPacketSamples(Uint8Array.of(0x78))).toBe(960); // hybrid FB 20 ms
  });

  it('reads Opus packets from a live WebM recording (unknown sizes)', () => {
    const packets = [Uint8Array.of(0xfc, 1, 2, 3), Uint8Array.of(0xfc, 4, 5), Uint8Array.of(0xfc, ...new Array(300).fill(9))];
    const r = parseWebmOpus(webm(packets));
    expect(r.packets).toEqual(packets);
    expect(new TextDecoder().decode(r.head!.subarray(0, 8))).toBe('OpusHead');
  });

  it('writes a valid Ogg Opus stream', () => {
    const packets = Array.from({ length: 120 }, (_, i) => Uint8Array.of(0xfc, i, ...(i === 7 ? new Array(600).fill(1) : [])));
    const ogg = webmToOgg(webm(packets));
    const pages = readPages(ogg);
    expect(pages[0]!.flags).toBe(0x02); // beginning of stream
    expect(new TextDecoder().decode(pages[0]!.packets[0]!.subarray(0, 8))).toBe('OpusHead');
    expect(new TextDecoder().decode(pages[1]!.packets[0]!.subarray(0, 8))).toBe('OpusTags');
    const data = pages.slice(2);
    expect(data.flatMap((p) => p.packets)).toEqual(packets);
    expect(data.at(-1)!.flags).toBe(0x04); // end of stream
    expect(data.at(-1)!.granule).toBe(120n * 960n);
    expect(pages.map((p) => p.seq)).toEqual(pages.map((_, i) => i));
  });

  it('uses the Ogg CRC (polynomial 0x04c11db7, unreflected)', () => {
    // Recompute the CRC of the first page with the field zeroed and compare.
    const ogg = oggOpus(null, []);
    const first = ogg.subarray(0, 27 + 1 + 19);
    const stored = new DataView(first.buffer, first.byteOffset).getUint32(22, true);
    const copy = first.slice();
    copy.fill(0, 22, 26);
    let c = 0;
    for (const x of copy) {
      c ^= x << 24;
      for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      c >>>= 0;
    }
    expect(stored).toBe(c);
  });
});
