import { hkdf, randomBytes, scrypt } from './primitives.js';

export const SALT_LEN = 32;

export interface DerivedKeys {
  /** Stored in the DB and compared on login. */
  authHash: Buffer;
  /** Never stored. Unwraps the owner's private key. */
  kek: Buffer;
}

export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export function newSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

/** master = scrypt(password); authHash and KEK are independent HKDF expansions of it. */
export async function derivePasswordKeys(password: string, salt: Buffer, logN: number): Promise<DerivedKeys> {
  const master = await scrypt(normalizePassword(password), salt, logN);
  try {
    return {
      authHash: hkdf(master, salt, 'wal/v1/auth'),
      kek: hkdf(master, salt, 'wal/v1/kek'),
    };
  } finally {
    master.fill(0);
  }
}

const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', '1234567890123', 'qwertyuiopas',
  'qwerty123456', 'iloveyou1234', 'letmein12345', 'administrator', 'passw0rd1234', 'whatsapp1234',
  'welcome12345', 'changeme1234', 'aaaaaaaaaaaa', '111111111111', '000000000000', 'abcdefghijkl',
  'abc123abc123', 'trustno11234',
]);

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Returns a user-facing reason when the password is unacceptable, otherwise null. */
export function passwordPolicyError(password: string, username: string): string | null {
  const pw = normalizePassword(password);
  if ([...pw].length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  const lower = pw.toLowerCase();
  if (username && lower.includes(username.toLowerCase()) && username.length >= 3) {
    return 'Password must not contain the username.';
  }
  if (COMMON_PASSWORDS.has(lower)) return 'This password is too common.';
  if (new Set(lower).size < 5) return 'Password is too repetitive.';
  return null;
}

/* ------------------------------------------------------------ recovery key */

// Crockford base32 alphabet (no I, L, O, U) — unambiguous when written down.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const RECOVERY_KEY_BYTES = 32;

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 32 random bytes, formatted as groups of 4 Crockford base32 characters. */
export function generateRecoveryKey(): { display: string; bytes: Buffer } {
  const bytes = randomBytes(RECOVERY_KEY_BYTES);
  const enc = base32Encode(bytes);
  const display = enc.match(/.{1,4}/g)!.join('-');
  return { display, bytes };
}

/** Accepts the displayed key with any separators/case; maps easily-confused letters. */
export function parseRecoveryKey(input: string): Buffer | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== Math.ceil((RECOVERY_KEY_BYTES * 8) / 5)) return null;
  const buf = base32Decode(cleaned);
  if (!buf || buf.length !== RECOVERY_KEY_BYTES) return null;
  return buf;
}

/** The recovery key has 256 bits of entropy, so HKDF (no slow KDF) is sufficient. */
export function deriveRecoveryKeys(recoveryBytes: Buffer, salt: Buffer): DerivedKeys {
  return {
    authHash: hkdf(recoveryBytes, salt, 'wal/v1/recovery-auth'),
    kek: hkdf(recoveryBytes, salt, 'wal/v1/recovery-kek'),
  };
}
