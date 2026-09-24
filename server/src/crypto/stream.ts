import fs from 'node:fs/promises';
import { CryptoError, KEY_LEN, NONCE_LEN, TAG_LEN, randomBytes, sealGcm, openGcm } from './primitives.js';

/*
 * Chunked AEAD file format for media (random access for HTTP Range):
 *   header  = "WAL1" ‖ version(1) ‖ keyId(u32be) ‖ noncePrefix(8) ‖ fileId(16)          (33 bytes)
 *   chunk_i = AES-256-GCM(key, nonce = noncePrefix ‖ u32be(i),
 *                         aad = "wal/v1|media|" ‖ fileId(hex) ‖ "|" ‖ i ‖ "|" ‖ final(0/1) ‖ header)
 *             of CHUNK plaintext bytes (the final chunk may be shorter, even empty).
 * The final flag in the AAD detects truncation; the index in nonce+AAD detects reordering.
 */

export const MAGIC = Buffer.from('WAL1', 'ascii');
export const FORMAT_VERSION = 1;
export const HEADER_LEN = 4 + 1 + 4 + 8 + 16;
export const CHUNK = 64 * 1024;
const ENC_CHUNK = CHUNK + TAG_LEN;

export interface MediaHeader {
  keyId: number;
  noncePrefix: Buffer;
  fileId: Buffer;
  raw: Buffer;
}

function buildHeader(keyId: number, noncePrefix: Buffer, fileId: Buffer): Buffer {
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0);
  h.writeUInt8(FORMAT_VERSION, 4);
  h.writeUInt32BE(keyId, 5);
  noncePrefix.copy(h, 9);
  fileId.copy(h, 17);
  return h;
}

export function parseHeader(h: Buffer): MediaHeader {
  if (h.length < HEADER_LEN || !h.subarray(0, 4).equals(MAGIC) || h.readUInt8(4) !== FORMAT_VERSION) {
    throw new CryptoError('bad media header');
  }
  return {
    keyId: h.readUInt32BE(5),
    noncePrefix: Buffer.from(h.subarray(9, 17)),
    fileId: Buffer.from(h.subarray(17, 33)),
    raw: Buffer.from(h.subarray(0, HEADER_LEN)),
  };
}

function chunkNonce(prefix: Buffer, index: number): Buffer {
  const n = Buffer.alloc(NONCE_LEN);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 8);
  return n;
}

function chunkAad(header: MediaHeader | Buffer, fileId: Buffer, index: number, final: boolean): Buffer {
  const raw = Buffer.isBuffer(header) ? header : header.raw;
  return Buffer.concat([Buffer.from(`wal/v1|media|${fileId.toString('hex')}|${index}|${final ? 1 : 0}|`), raw]);
}

/** Plaintext size implied by an encrypted file size. */
export function plaintextSizeFromFileSize(fileSize: number): number {
  const body = fileSize - HEADER_LEN;
  if (body < TAG_LEN) throw new CryptoError('truncated media file');
  const n = Math.ceil(body / ENC_CHUNK);
  const size = body - n * TAG_LEN;
  if (size < 0) throw new CryptoError('truncated media file');
  return size;
}

/**
 * Streaming encryptor. Writes to `<path>.tmp` and atomically renames on finish().
 * A chunk is flushed only when *more* than CHUNK bytes are pending, so finish() always has a
 * (possibly empty) final chunk to write.
 */
export class MediaFileWriter {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private index = 0;
  private written = 0;
  private closed = false;

  private constructor(
    private readonly fh: fs.FileHandle,
    private readonly path: string,
    private readonly key: Buffer,
    private readonly header: Buffer,
    private readonly noncePrefix: Buffer,
    private readonly fileId: Buffer,
  ) {}

  static async create(path: string, key: Buffer, keyId: number, fileId: Buffer): Promise<MediaFileWriter> {
    if (key.length !== KEY_LEN) throw new Error('bad key');
    if (fileId.length !== 16) throw new Error('fileId must be 16 bytes');
    const noncePrefix = randomBytes(8);
    const header = buildHeader(keyId, noncePrefix, fileId);
    const fh = await fs.open(`${path}.tmp`, 'wx', 0o600);
    await fh.write(header, 0, header.length, 0);
    // Copy the key: the caller's DEK buffer may be rotated/zeroed independently.
    return new MediaFileWriter(fh, path, Buffer.from(key), header, noncePrefix, fileId);
  }

  get bytesWritten(): number {
    return this.written + this.pendingLen;
  }

  private async emit(plain: Buffer, final: boolean): Promise<void> {
    const sealed = sealGcm(this.key, plain, chunkAad(this.header, this.fileId, this.index, final), chunkNonce(this.noncePrefix, this.index));
    // sealGcm prefixes the nonce; the nonce is derivable, so store only ciphertext ‖ tag.
    const body = sealed.subarray(NONCE_LEN);
    await this.fh.write(body, 0, body.length, HEADER_LEN + this.index * ENC_CHUNK);
    this.index++;
    this.written += plain.length;
  }

  async write(data: Buffer): Promise<void> {
    if (this.closed) throw new Error('writer closed');
    this.pending.push(data);
    this.pendingLen += data.length;
    while (this.pendingLen > CHUNK) {
      const all = Buffer.concat(this.pending);
      const chunk = all.subarray(0, CHUNK);
      const rest = all.subarray(CHUNK);
      this.pending = [Buffer.from(rest)];
      this.pendingLen = rest.length;
      await this.emit(Buffer.from(chunk), false);
    }
  }

  async finish(): Promise<{ size: number }> {
    if (this.closed) throw new Error('writer closed');
    const last = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingLen = 0;
    await this.emit(last, true);
    await this.fh.sync();
    await this.fh.close();
    this.closed = true;
    this.key.fill(0);
    await fs.rename(`${this.path}.tmp`, this.path);
    return { size: this.written };
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
    await this.fh.close().catch(() => undefined);
    await fs.rm(`${this.path}.tmp`, { force: true });
  }
}

export interface OpenedMedia {
  header: MediaHeader;
  size: number;
  fh: fs.FileHandle;
}

export async function openMediaFile(path: string): Promise<OpenedMedia> {
  const fh = await fs.open(path, 'r');
  try {
    const st = await fh.stat();
    const hb = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fh.read(hb, 0, HEADER_LEN, 0);
    if (bytesRead !== HEADER_LEN) throw new CryptoError('truncated media file');
    return { header: parseHeader(hb), size: plaintextSizeFromFileSize(st.size), fh };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/**
 * Decrypts plaintext bytes [start, end] (inclusive) of an opened media file, yielding buffers.
 * Only the chunks overlapping the range are read and authenticated.
 */
export async function* decryptRange(media: OpenedMedia, key: Buffer, start: number, end: number): AsyncGenerator<Buffer> {
  const { header, size, fh } = media;
  if (size === 0) return;
  if (start < 0 || end >= size || start > end) throw new RangeError('bad range');
  const lastIndex = size === 0 ? 0 : Math.floor((size - 1) / CHUNK);
  const first = Math.floor(start / CHUNK);
  const last = Math.floor(end / CHUNK);
  const buf = Buffer.alloc(ENC_CHUNK);
  for (let i = first; i <= last; i++) {
    const final = i === lastIndex;
    const plainLen = final ? size - i * CHUNK : CHUNK;
    const encLen = plainLen + TAG_LEN;
    const { bytesRead } = await fh.read(buf, 0, encLen, HEADER_LEN + i * ENC_CHUNK);
    if (bytesRead !== encLen) throw new CryptoError('truncated media file');
    const sealed = Buffer.concat([chunkNonce(header.noncePrefix, i), buf.subarray(0, encLen)]);
    const plain = openGcm(key, sealed, chunkAad(header, header.fileId, i, final));
    const from = i === first ? start - i * CHUNK : 0;
    const to = i === last ? end - i * CHUNK + 1 : plain.length;
    yield plain.subarray(from, to);
  }
}

/** Decrypts a whole (small) media file into memory. */
export async function decryptAll(path: string, keyFor: (keyId: number) => Buffer): Promise<Buffer> {
  const media = await openMediaFile(path);
  try {
    if (media.size === 0) {
      // Still authenticate the empty final chunk.
      const parts: Buffer[] = [];
      const key = keyFor(media.header.keyId);
      const buf = Buffer.alloc(TAG_LEN);
      const { bytesRead } = await media.fh.read(buf, 0, TAG_LEN, HEADER_LEN);
      if (bytesRead !== TAG_LEN) throw new CryptoError('truncated media file');
      openGcm(key, Buffer.concat([chunkNonce(media.header.noncePrefix, 0), buf]), chunkAad(media.header, media.header.fileId, 0, true));
      return Buffer.concat(parts);
    }
    const parts: Buffer[] = [];
    for await (const p of decryptRange(media, keyFor(media.header.keyId), 0, media.size - 1)) parts.push(Buffer.from(p));
    return Buffer.concat(parts);
  } finally {
    await media.fh.close();
  }
}
