import crypto from 'node:crypto';

export const KEY_LEN = 32;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;

export class CryptoError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'CryptoError';
  }
}

export class BusyError extends Error {
  constructor() {
    super('server busy');
    this.name = 'BusyError';
  }
}

export function randomBytes(n: number): Buffer {
  return crypto.randomBytes(n);
}

export function randomKey(): Buffer {
  return crypto.randomBytes(KEY_LEN);
}

function toBuf(v: Buffer | string): Buffer {
  return typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
}

/** AES-256-GCM seal. Output: nonce(12) ‖ ciphertext ‖ tag(16). */
export function sealGcm(key: Buffer, plaintext: Buffer, aad: Buffer | string, nonce?: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error('bad key length');
  const iv = nonce ?? crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(toBuf(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** AES-256-GCM open (inverse of sealGcm). Throws CryptoError on any failure. */
export function openGcm(key: Buffer, sealed: Buffer, aad: Buffer | string): Buffer {
  if (key.length !== KEY_LEN) throw new CryptoError('bad key length');
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new CryptoError('ciphertext too short');
  const iv = sealed.subarray(0, NONCE_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const ct = sealed.subarray(NONCE_LEN, sealed.length - TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(toBuf(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError();
  }
}

export function hkdf(ikm: Buffer, salt: Buffer, info: string, len = KEY_LEN): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len));
}

export function sha256(data: Buffer | string): Buffer {
  return crypto.createHash('sha256').update(toBuf(data)).digest();
}

export function hmacSha256(key: Buffer, data: Buffer | string): Buffer {
  return crypto.createHmac('sha256', key).update(toBuf(data)).digest();
}

/** Constant-time equality for buffers/strings of possibly different length. */
export function ctEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ab = toBuf(a);
  const bb = toBuf(b);
  // Compare fixed-length digests so the length difference is not leaked through timing.
  const da = sha256(ab);
  const db = sha256(bb);
  return crypto.timingSafeEqual(da, db) && ab.length === bb.length;
}

/* ------------------------------------------------------------------ scrypt */

const SCRYPT_MAX_CONCURRENT = 2;
const SCRYPT_MAX_QUEUE = 16;
let scryptActive = 0;
const scryptQueue: Array<() => void> = [];

async function acquireScrypt(): Promise<void> {
  if (scryptActive < SCRYPT_MAX_CONCURRENT) {
    scryptActive++;
    return;
  }
  if (scryptQueue.length >= SCRYPT_MAX_QUEUE) throw new BusyError();
  await new Promise<void>((resolve) => scryptQueue.push(resolve));
  scryptActive++;
}

function releaseScrypt(): void {
  scryptActive--;
  const next = scryptQueue.shift();
  if (next) next();
}

/**
 * scrypt with N = 2^logN, r = 8, p = 1. Concurrency is bounded (each call needs ~128 MiB at logN=17),
 * so a burst of login attempts cannot exhaust memory; excess callers get BusyError.
 */
export async function scrypt(password: string, salt: Buffer, logN: number, len = KEY_LEN): Promise<Buffer> {
  await acquireScrypt();
  try {
    const N = 2 ** logN;
    const r = 8;
    const maxmem = 128 * N * r * 2 + 16 * 1024 * 1024;
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, len, { N, r, p: 1, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
    });
  } finally {
    releaseScrypt();
  }
}

/* ------------------------------------------------------------------ X25519 */

export interface X25519KeyPair {
  publicRaw: Buffer; // 32 bytes
  privatePkcs8: Buffer; // DER
}

export function generateX25519(): X25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('x25519 export failed');
  return {
    publicRaw: Buffer.from(jwk.x, 'base64url'),
    privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }),
  };
}

export function x25519PublicKeyObject(publicRaw: Buffer): crypto.KeyObject {
  if (publicRaw.length !== 32) throw new CryptoError('bad public key');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicRaw.toString('base64url') }, format: 'jwk' });
}

export function x25519PrivateKeyObject(privatePkcs8: Buffer): crypto.KeyObject {
  try {
    return crypto.createPrivateKey({ key: privatePkcs8, format: 'der', type: 'pkcs8' });
  } catch {
    throw new CryptoError('bad private key');
  }
}

export function x25519Shared(privateKey: crypto.KeyObject, publicRaw: Buffer): Buffer {
  const shared = crypto.diffieHellman({ privateKey, publicKey: x25519PublicKeyObject(publicRaw) });
  // Reject the all-zero output produced by low-order public keys.
  if (shared.every((b) => b === 0)) throw new CryptoError('invalid shared secret');
  return shared;
}

export function x25519PublicFromPrivate(privateKey: crypto.KeyObject): Buffer {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  if (!jwk.x) throw new CryptoError('bad private key');
  return Buffer.from(jwk.x, 'base64url');
}
