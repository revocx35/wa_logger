import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KEY_LEN, openGcm, randomKey, sealGcm, sha256 } from '../crypto/primitives.js';
import type { Repo } from '../db/repo.js';

/** `walt_<tenant>_<256 random bits>`: the tenant id lets the gateway pick the worker; the rest is the secret. */
const TOKEN_RE = /^walt_(\d{1,5})_([A-Za-z0-9_-]{43})$/;
const TOUCH_MS = 60_000;

export interface TokenDestination {
  chatId: string;
  kind: string;
  name: string | null;
}

/**
 * Bearer tokens for other apps. A token can do exactly two things: list the chats it was given and send text to them.
 * It cannot read messages. Only sha256(token) is stored, so a database copy cannot be turned back into a working token.
 *
 * The chat names a token's holder sees (to offer a picker) were copied, sealed with a key file next to the database,
 * when the owner created the token: the user's own sealed data needs the session key, which an app has no access to.
 * Same deliberate, narrow exception as the block list's contact directory: names of chats the owner chose, nothing else.
 */
export class ApiTokens {
  private key: Buffer | null = null;
  private readonly touched = new Map<number, number>();

  constructor(
    private readonly repo: Repo,
    private readonly dataDir: string,
    private readonly tenant: number,
  ) {}

  private labelKey(): Buffer {
    if (this.key) return this.key;
    const file = path.join(this.dataDir, 'apitoken.key');
    try {
      this.key = fs.readFileSync(file);
    } catch {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(file, randomKey(), { flag: 'wx', mode: 0o600 });
      } catch {
        /* created by a concurrent call */
      }
      this.key = fs.readFileSync(file);
    }
    if (this.key.length !== KEY_LEN) throw new Error('bad api token key');
    return this.key;
  }

  /** Creates a token for [chats] (id, kind and display name as the owner sees them). The secret is returned once. */
  create(name: string, chats: { id: string; kind: string; name: string | null }[]): { id: number; token: string } {
    const token = `walt_${this.tenant}_${crypto.randomBytes(32).toString('base64url')}`;
    const id = this.repo.insertApiToken({
      hash: sha256(token),
      name,
      now: Date.now(),
      chats: chats.map((c) => ({
        id: c.id,
        kind: c.kind,
        label_enc: c.name ? sealGcm(this.labelKey(), Buffer.from(c.name.slice(0, 200), 'utf8'), `wal/apitoken|${c.id}`) : null,
      })),
    });
    return { id, token };
  }

  /** The token behind an Authorization header value, or null (wrong scheme, malformed, unknown). */
  authenticate(header: string | undefined, now = Date.now()): { id: number; name: string } | null {
    const m = /^Bearer (\S{1,100})$/.exec(header ?? '');
    const token = m?.[1];
    if (!token || !TOKEN_RE.test(token)) return null;
    const row = this.repo.getApiTokenByHash(sha256(token));
    if (!row) return null;
    if (now - (this.touched.get(row.id) ?? 0) > TOUCH_MS) {
      this.touched.set(row.id, now);
      this.repo.touchApiToken(row.id, now);
    }
    return row;
  }

  destinations(tokenId: number): TokenDestination[] {
    return this.repo.listApiTokenChats(tokenId).map((c) => {
      let name: string | null = null;
      if (c.label_enc) {
        try {
          name = openGcm(this.labelKey(), c.label_enc, `wal/apitoken|${c.chat_id}`).toString('utf8');
        } catch {
          name = null;
        }
      }
      return { chatId: c.chat_id, kind: c.kind, name };
    });
  }
}
