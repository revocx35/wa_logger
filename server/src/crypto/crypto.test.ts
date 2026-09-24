import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import {
  DataReader,
  DataWriter,
  PRIVKEY_AAD,
  generateX25519,
  unwrapDek,
  unwrapPrivateKey,
  wrapDek,
  wrapPrivateKey,
} from './keyring.js';
import {
  derivePasswordKeys,
  deriveRecoveryKeys,
  generateRecoveryKey,
  parseRecoveryKey,
  passwordPolicyError,
} from './password.js';
import { CryptoError, ctEqual, openGcm, randomKey, sealGcm, x25519PrivateKeyObject } from './primitives.js';
import { CHUNK, HEADER_LEN, MediaFileWriter, decryptAll, decryptRange, openMediaFile, plaintextSizeFromFileSize } from './stream.js';

describe('primitives', () => {
  it('seals and opens with matching AAD, rejects tampering', () => {
    const key = randomKey();
    const sealed = sealGcm(key, Buffer.from('hello'), 'ctx');
    expect(openGcm(key, sealed, 'ctx').toString()).toBe('hello');
    expect(() => openGcm(key, sealed, 'other')).toThrow(CryptoError);
    const bad = Buffer.from(sealed);
    bad[14] = (bad[14] ?? 0) ^ 1;
    expect(() => openGcm(key, bad, 'ctx')).toThrow(CryptoError);
    expect(() => openGcm(randomKey(), sealed, 'ctx')).toThrow(CryptoError);
  });

  it('ctEqual compares correctly', () => {
    expect(ctEqual('abc', 'abc')).toBe(true);
    expect(ctEqual('abc', 'abd')).toBe(false);
    expect(ctEqual('abc', 'abcd')).toBe(false);
  });
});

describe('password & recovery', () => {
  it('derives deterministic, independent auth hash and KEK', async () => {
    const salt = Buffer.alloc(32, 7);
    const a = await derivePasswordKeys('correct horse battery', salt, 10);
    const b = await derivePasswordKeys('correct horse battery', salt, 10);
    const c = await derivePasswordKeys('correct horse batterY', salt, 10);
    expect(a.authHash.equals(b.authHash)).toBe(true);
    expect(a.kek.equals(b.kek)).toBe(true);
    expect(a.authHash.equals(a.kek)).toBe(false);
    expect(a.authHash.equals(c.authHash)).toBe(false);
  });

  it('normalizes unicode passwords (NFKC)', async () => {
    const salt = Buffer.alloc(32, 1);
    const composed = await derivePasswordKeys('pässwörd-long-enough', salt, 10);
    const decomposed = await derivePasswordKeys('pässwörd-long-enough', salt, 10);
    expect(composed.authHash.equals(decomposed.authHash)).toBe(true);
  });

  it('enforces the password policy', () => {
    expect(passwordPolicyError('short', 'owner')).toMatch(/at least/);
    expect(passwordPolicyError('password1234', 'owner')).toMatch(/common/);
    expect(passwordPolicyError('owner-is-my-password', 'owner')).toMatch(/username/);
    expect(passwordPolicyError('aaaaaaaaaaaaab', 'owner')).toMatch(/repetitive/);
    expect(passwordPolicyError('a-perfectly-fine-passphrase', 'owner')).toBeNull();
  });

  it('round-trips recovery keys and tolerates formatting', () => {
    const { display, bytes } = generateRecoveryKey();
    expect(display).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(parseRecoveryKey(display)!.equals(bytes)).toBe(true);
    expect(parseRecoveryKey(display.toLowerCase().replace(/-/g, ' '))!.equals(bytes)).toBe(true);
    expect(parseRecoveryKey('nope')).toBeNull();
    const salt = Buffer.alloc(32, 3);
    const k1 = deriveRecoveryKeys(bytes, salt);
    expect(k1.kek.equals(deriveRecoveryKeys(bytes, salt).kek)).toBe(true);
  });
});

describe('keyring', () => {
  let dir: string;
  let repo: Repo;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-crypto-'));
    repo = new Repo(openDb(path.join(dir, 'db.sqlite')));
  });
  afterAll(async () => {
    repo.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('wraps and unwraps the private key only with the right KEK and AAD', () => {
    const kp = generateX25519();
    const kek = randomKey();
    const w = wrapPrivateKey(kek, kp.privatePkcs8, PRIVKEY_AAD.password);
    expect(unwrapPrivateKey(kek, w, PRIVKEY_AAD.password).equals(kp.privatePkcs8)).toBe(true);
    expect(() => unwrapPrivateKey(kek, w, PRIVKEY_AAD.session)).toThrow(CryptoError);
    expect(() => unwrapPrivateKey(randomKey(), w, PRIVKEY_AAD.password)).toThrow(CryptoError);
  });

  it('ECIES-wraps DEKs to the owner public key', () => {
    const kp = generateX25519();
    const other = generateX25519();
    const dek = randomKey();
    const w = wrapDek(kp.publicRaw, dek);
    expect(unwrapDek(x25519PrivateKeyObject(kp.privatePkcs8), kp.publicRaw, w).equals(dek)).toBe(true);
    expect(() => unwrapDek(x25519PrivateKeyObject(other.privatePkcs8), other.publicRaw, w)).toThrow(CryptoError);
  });

  it('writer encrypts fields that only the private key holder can read; AAD binds location', () => {
    const kp = generateX25519();
    const writer = new DataWriter(repo, kp.publicRaw);
    const blob = writer.encrypt('messages', 'meta', 'msg-1', 'secret text')!;
    expect(blob.includes(Buffer.from('secret text'))).toBe(false);
    const reader = DataReader.fromPkcs8(repo, kp.privatePkcs8);
    expect(reader.decrypt('messages', 'meta', 'msg-1', blob)!.toString()).toBe('secret text');
    expect(() => reader.decrypt('messages', 'meta', 'msg-2', blob)).toThrow(CryptoError);
    expect(() => reader.decrypt('messages', 'body', 'msg-1', blob)).toThrow(CryptoError);
    expect(reader.tryText('messages', 'meta', 'msg-2', blob)).toBeNull();
    expect(writer.encrypt('messages', 'meta', 'x', null)).toBeNull();
    const other = generateX25519();
    const wrongReader = DataReader.fromPkcs8(repo, other.privatePkcs8);
    expect(() => wrongReader.decrypt('messages', 'meta', 'msg-1', blob)).toThrow(CryptoError);
  });

  it('rotates DEKs after 24h and can still read old data', () => {
    const kp = generateX25519();
    let now = 1_000_000;
    const writer = new DataWriter(repo, kp.publicRaw, () => now);
    const b1 = writer.encryptJson('messages', 'meta', 'a', { v: 1 })!;
    const id1 = writer.currentKey().id;
    now += 25 * 3600_000;
    const b2 = writer.encryptJson('messages', 'meta', 'b', { v: 2 })!;
    const id2 = writer.currentKey().id;
    expect(id2).not.toBe(id1);
    const reader = DataReader.fromPkcs8(repo, kp.privatePkcs8);
    expect(reader.tryJson<{ v: number }>('messages', 'meta', 'a', b1)).toEqual({ v: 1 });
    expect(reader.tryJson<{ v: number }>('messages', 'meta', 'b', b2)).toEqual({ v: 2 });
  });
});

describe('media stream format', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-media-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeFile(name: string, data: Buffer, key: Buffer, pieces = 7) {
    const p = path.join(dir, name);
    const w = await MediaFileWriter.create(p, key, 42, Buffer.alloc(16, name.length));
    const step = Math.max(1, Math.ceil(data.length / pieces));
    for (let i = 0; i < data.length; i += step) await w.write(data.subarray(i, i + step));
    const { size } = await w.finish();
    expect(size).toBe(data.length);
    return p;
  }

  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 12345]) {
    it(`round-trips ${size} bytes and supports ranges`, async () => {
      const key = randomKey();
      const data = Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255));
      const p = await writeFile(`f${size}.bin`, data, key);
      const st = await fs.stat(p);
      expect(plaintextSizeFromFileSize(st.size)).toBe(size);
      const all = await decryptAll(p, () => key);
      expect(all.equals(data)).toBe(true);
      if (size > 10) {
        const m = await openMediaFile(p);
        const parts: Buffer[] = [];
        const s = Math.floor(size / 3);
        const e = size - 2;
        for await (const part of decryptRange(m, key, s, e)) parts.push(Buffer.from(part));
        await m.fh.close();
        expect(Buffer.concat(parts).equals(data.subarray(s, e + 1))).toBe(true);
      }
    });
  }

  it('detects truncation, tampering and wrong key', async () => {
    const key = randomKey();
    const data = Buffer.alloc(3 * CHUNK + 100, 9);
    const p = await writeFile('t.bin', data, key);
    // wrong key
    await expect(decryptAll(p, () => randomKey())).rejects.toThrow(CryptoError);
    // tamper one byte in the middle chunk
    const raw = await fs.readFile(p);
    const tampered = Buffer.from(raw);
    tampered[HEADER_LEN + CHUNK + 50] = (tampered[HEADER_LEN + CHUNK + 50] ?? 0) ^ 0xff;
    await fs.writeFile(p + '.x', tampered);
    await expect(decryptAll(p + '.x', () => key)).rejects.toThrow(CryptoError);
    // truncate to exactly 3 full chunks (drops the final chunk)
    await fs.writeFile(p + '.y', raw.subarray(0, HEADER_LEN + 3 * (CHUNK + 16)));
    await expect(decryptAll(p + '.y', () => key)).rejects.toThrow(CryptoError);
    // swap two chunks
    const swapped = Buffer.from(raw);
    raw.copy(swapped, HEADER_LEN, HEADER_LEN + (CHUNK + 16), HEADER_LEN + 2 * (CHUNK + 16));
    raw.copy(swapped, HEADER_LEN + (CHUNK + 16), HEADER_LEN, HEADER_LEN + (CHUNK + 16));
    await fs.writeFile(p + '.z', swapped);
    await expect(decryptAll(p + '.z', () => key)).rejects.toThrow(CryptoError);
  });

  it('abort removes the temp file', async () => {
    const p = path.join(dir, 'aborted.bin');
    const w = await MediaFileWriter.create(p, randomKey(), 1, Buffer.alloc(16));
    await w.write(Buffer.alloc(10));
    await w.abort();
    await expect(fs.stat(p + '.tmp')).rejects.toThrow();
    await expect(fs.stat(p)).rejects.toThrow();
  });
});
