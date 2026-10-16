/**
 * Voice notes: WhatsApp plays Ogg/Opus. Firefox records that directly; Chromium's MediaRecorder only writes
 * WebM/Opus, so its recording is remuxed here (same Opus packets, new container; no re-encoding).
 */

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(p: Uint8Array): number {
  if (p.length < 1) return 0;
  const toc = p[0]!;
  const config = toc >> 3;
  let frame: number;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]!; // SILK: 10/20/40/60 ms
  else if (config < 16) frame = (config & 1) === 0 ? 480 : 960; // Hybrid: 10/20 ms
  else frame = [120, 240, 480, 960][config & 3]!; // CELT: 2.5/5/10/20 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (p.length > 1 ? p[1]! & 0x3f : 0) : 2;
  return frame * frames;
}

/* --------------------------------------------------------------- WebM */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  BlockGroup: 0xa0,
  Block: 0xa1,
  SimpleBlock: 0xa3,
};
const MASTER = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.BlockGroup]);

function vint(b: Uint8Array, pos: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } {
  const first = b[pos];
  if (first === undefined || first === 0) throw new Error('bad EBML');
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const x = b[pos + i];
    if (x === undefined) throw new Error('truncated EBML');
    if (x !== 0xff) allOnes = false;
    value = value * 256 + x;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

/** Opus packets and the OpusHead (CodecPrivate) of the first Opus track of a WebM file. */
export function parseWebmOpus(b: Uint8Array): { head: Uint8Array | null; packets: Uint8Array[] } {
  const packets: Uint8Array[] = [];
  let head: Uint8Array | null = null;
  let codec: string | null = null;
  let pos = 0;
  while (pos < b.length) {
    const id = vint(b, pos, true);
    const size = vint(b, pos + id.len, false);
    const start = pos + id.len + size.len;
    if (MASTER.has(id.value) || size.unknown) {
      pos = start; // descend (live recordings use unknown sizes for Segment and Cluster)
      continue;
    }
    const end = Math.min(b.length, start + size.value);
    if (id.value === ID.CodecID) codec = new TextDecoder().decode(b.subarray(start, end));
    else if (id.value === ID.CodecPrivate && codec === 'A_OPUS') head = b.slice(start, end);
    else if (id.value === ID.SimpleBlock || id.value === ID.Block) {
      const track = vint(b, start, false);
      const flags = b[start + track.len + 2] ?? 0;
      if ((flags & 0x06) === 0 && track.value === 1) packets.push(b.slice(start + track.len + 3, end)); // no lacing
    }
    pos = end;
  }
  if (codec !== null && codec !== 'A_OPUS') throw new Error('not Opus');
  return { head, packets };
}

/* ---------------------------------------------------------------- Ogg */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc(data: Uint8Array): number {
  let c = 0;
  for (const x of data) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ x) & 0xff]!) >>> 0;
  return c;
}

function page(packets: Uint8Array[], granule: bigint, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  out[5] = flags;
  v.setBigUint64(6, granule, true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let off = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, off);
    off += p.length;
  }
  v.setUint32(22, crc(out), true);
  return out;
}

function defaultHead(): Uint8Array {
  const h = new Uint8Array(19);
  h.set(new TextEncoder().encode('OpusHead'));
  const v = new DataView(h.buffer);
  h[8] = 1; // version
  h[9] = 1; // mono
  v.setUint16(10, 312, true); // pre-skip
  v.setUint32(12, 48000, true);
  return h;
}

/** Wraps Opus packets in an Ogg Opus stream (RFC 7845). */
export function oggOpus(head: Uint8Array | null, packets: Uint8Array[]): Uint8Array {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const vendor = new TextEncoder().encode('wa_logger');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages: Uint8Array[] = [page([head ?? defaultHead()], 0n, serial, 0, 0x02), page([tags], 0n, serial, 1, 0)];
  let granule = 0n;
  let seq = 2;
  // About one second of audio per page.
  for (let i = 0; i < packets.length; i += 50) {
    const batch = packets.slice(i, i + 50);
    for (const p of batch) granule += BigInt(opusPacketSamples(p));
    pages.push(page(batch, granule, serial, seq++, i + 50 >= packets.length ? 0x04 : 0));
  }
  if (packets.length === 0) pages.push(page([], 0n, serial, seq, 0x04));
  const total = pages.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pages) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function webmToOgg(webm: Uint8Array): Uint8Array {
  const { head, packets } = parseWebmOpus(webm);
  return oggOpus(head, packets);
}
