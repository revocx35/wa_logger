import type { KeyObject } from 'node:crypto';
import {
  CryptoError,
  KEY_LEN,
  generateX25519,
  hkdf,
  openGcm,
  randomKey,
  sealGcm,
  x25519PrivateKeyObject,
  x25519PublicFromPrivate,
  x25519Shared,
} from './primitives.js';

/*
 * Envelope encryption (see ARCHITECTURE.md §6):
 *   owner X25519 keypair ─ private key wrapped by password KEK / recovery KEK / session key
 *   DEK (random 32B) ─ wrapped to the owner's public key with ECIES, stored in data_keys
 *   fields & media ─ AES-256-GCM under a DEK, AAD-bound to their location
 */

const FIELD_VERSION = 0x01;
const FIELD_HEADER_LEN = 1 + 4; // version ‖ keyId(u32be)

export const PRIVKEY_AAD = {
  password: 'wal/v1|privkey|password',
  recovery: 'wal/v1|privkey|recovery',
  session: 'wal/v1|privkey|session',
} as const;

export function wrapPrivateKey(kek: Buffer, privatePkcs8: Buffer, aad: string): Buffer {
  return sealGcm(kek, privatePkcs8, aad);
}

export function unwrapPrivateKey(kek: Buffer, sealed: Buffer, aad: string): Buffer {
  return openGcm(kek, sealed, aad);
}

export { generateX25519 };

/* ------------------------------------------------------------------- DEKs */

export interface WrappedDek {
  ephPub: Buffer;
  wrapped: Buffer;
}

function dekWrapKey(shared: Buffer, ephPub: Buffer, ownerPub: Buffer): Buffer {
  return hkdf(shared, Buffer.concat([ephPub, ownerPub]), 'wal/v1/dek');
}

/** ECIES: ephemeral X25519 → ECDH with the owner's public key → HKDF → AES-256-GCM. */
export function wrapDek(ownerPublicRaw: Buffer, dek: Buffer): WrappedDek {
  const eph = generateX25519();
  const shared = x25519Shared(x25519PrivateKeyObject(eph.privatePkcs8), ownerPublicRaw);
  const key = dekWrapKey(shared, eph.publicRaw, ownerPublicRaw);
  const wrapped = sealGcm(key, dek, 'wal/v1|dek');
  shared.fill(0);
  key.fill(0);
  return { ephPub: eph.publicRaw, wrapped };
}

export function unwrapDek(ownerPrivate: KeyObject, ownerPublicRaw: Buffer, w: WrappedDek): Buffer {
  const shared = x25519Shared(ownerPrivate, w.ephPub);
  const key = dekWrapKey(shared, w.ephPub, ownerPublicRaw);
  try {
    const dek = openGcm(key, w.wrapped, 'wal/v1|dek');
    if (dek.length !== KEY_LEN) throw new CryptoError('bad dek');
    return dek;
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}

/** Generic ECIES seal to the owner's public key: ephPub(32) ‖ AES-GCM(nonce ‖ ct ‖ tag). */
export function sealToPublicKey(ownerPublicRaw: Buffer, plaintext: Buffer, context: string): Buffer {
  const eph = generateX25519();
  const shared = x25519Shared(x25519PrivateKeyObject(eph.privatePkcs8), ownerPublicRaw);
  const key = hkdf(shared, Buffer.concat([eph.publicRaw, ownerPublicRaw]), `wal/v1/seal/${context}`);
  try {
    return Buffer.concat([eph.publicRaw, sealGcm(key, plaintext, `wal/v1|seal|${context}`)]);
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}

export function openSealed(ownerPrivate: KeyObject, blob: Buffer, context: string): Buffer {
  if (blob.length < 32 + 28) throw new CryptoError('sealed blob too short');
  const ephPub = blob.subarray(0, 32);
  const ownerPub = x25519PublicFromPrivate(ownerPrivate);
  const shared = x25519Shared(ownerPrivate, ephPub);
  const key = hkdf(shared, Buffer.concat([ephPub, ownerPub]), `wal/v1/seal/${context}`);
  try {
    return openGcm(key, blob.subarray(32), `wal/v1|seal|${context}`);
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}

export interface DataKeyStore {
  insertDataKey(ephPub: Buffer, wrapped: Buffer, createdAt: number): number;
  getDataKey(id: number): WrappedDek | undefined;
}

/* ------------------------------------------------------------ field format */

export function fieldAad(table: string, column: string, rowId: string | number, header: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`wal/v1|${table}|${column}|${rowId}|`, 'utf8'), header]);
}

function fieldHeader(keyId: number): Buffer {
  const h = Buffer.alloc(FIELD_HEADER_LEN);
  h.writeUInt8(FIELD_VERSION, 0);
  h.writeUInt32BE(keyId, 1);
  return h;
}

export function parseFieldKeyId(blob: Buffer): number {
  if (blob.length < FIELD_HEADER_LEN || blob.readUInt8(0) !== FIELD_VERSION) throw new CryptoError('bad field header');
  return blob.readUInt32BE(1);
}

export function encryptFieldWith(
  key: Buffer,
  keyId: number,
  table: string,
  column: string,
  rowId: string | number,
  plaintext: Buffer,
): Buffer {
  const header = fieldHeader(keyId);
  return Buffer.concat([header, sealGcm(key, plaintext, fieldAad(table, column, rowId, header))]);
}

export function decryptFieldWith(key: Buffer, table: string, column: string, rowId: string | number, blob: Buffer): Buffer {
  const header = blob.subarray(0, FIELD_HEADER_LEN);
  parseFieldKeyId(blob);
  return openGcm(key, blob.subarray(FIELD_HEADER_LEN), fieldAad(table, column, rowId, header));
}

/* ----------------------------------------------------------------- writer */

const DEK_ROTATE_MS = 24 * 3600_000;

/**
 * Encrypts new data. Holds only the *current* DEK in memory; it can never read data written under
 * earlier DEKs (that needs the owner's private key, which only a logged-in session can unlock).
 */
export class DataWriter {
  private current: { id: number; key: Buffer; createdAt: number } | null = null;

  constructor(
    private readonly store: DataKeyStore,
    private readonly ownerPublicRaw: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  currentKey(): { id: number; key: Buffer } {
    const t = this.now();
    if (!this.current || t - this.current.createdAt > DEK_ROTATE_MS) {
      // The previous key is not zeroed here: an in-flight media write may still be using it.
      const key = randomKey();
      const w = wrapDek(this.ownerPublicRaw, key);
      const id = this.store.insertDataKey(w.ephPub, w.wrapped, t);
      this.current = { id, key, createdAt: t };
    }
    return { id: this.current.id, key: this.current.key };
  }

  encrypt(table: string, column: string, rowId: string | number, value: Buffer | string | null | undefined): Buffer | null {
    if (value === null || value === undefined) return null;
    const { id, key } = this.currentKey();
    const pt = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    return encryptFieldWith(key, id, table, column, rowId, pt);
  }

  encryptJson(table: string, column: string, rowId: string | number, value: unknown): Buffer | null {
    if (value === null || value === undefined) return null;
    return this.encrypt(table, column, rowId, JSON.stringify(value));
  }

  dispose(): void {
    this.current?.key.fill(0);
    this.current = null;
  }
}

/* ----------------------------------------------------------------- reader */

/**
 * Request-scoped decryptor. Created from the session-unlocked private key and discarded at the end
 * of the request; unwrapped DEKs live only in this object.
 */
export class DataReader {
  private readonly deks = new Map<number, Buffer>();
  private readonly ownerPublicRaw: Buffer;

  constructor(
    private readonly store: DataKeyStore,
    private readonly ownerPrivate: KeyObject,
  ) {
    this.ownerPublicRaw = x25519PublicFromPrivate(ownerPrivate);
  }

  static fromPkcs8(store: DataKeyStore, privatePkcs8: Buffer): DataReader {
    return new DataReader(store, x25519PrivateKeyObject(privatePkcs8));
  }

  key(keyId: number): Buffer {
    let k = this.deks.get(keyId);
    if (!k) {
      const w = this.store.getDataKey(keyId);
      if (!w) throw new CryptoError('unknown data key');
      k = unwrapDek(this.ownerPrivate, this.ownerPublicRaw, w);
      this.deks.set(keyId, k);
    }
    return k;
  }

  decrypt(table: string, column: string, rowId: string | number, blob: Buffer | null | undefined): Buffer | null {
    if (!blob) return null;
    return decryptFieldWith(this.key(parseFieldKeyId(blob)), table, column, rowId, blob);
  }

  /** Like decrypt, but returns null instead of throwing on corrupted/tampered data. */
  tryText(table: string, column: string, rowId: string | number, blob: Buffer | null | undefined): string | null {
    try {
      return this.decrypt(table, column, rowId, blob)?.toString('utf8') ?? null;
    } catch {
      return null;
    }
  }

  tryJson<T>(table: string, column: string, rowId: string | number, blob: Buffer | null | undefined): T | null {
    const s = this.tryText(table, column, rowId, blob);
    if (s === null) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const k of this.deks.values()) k.fill(0);
    this.deks.clear();
  }
}
