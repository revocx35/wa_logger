import fs from 'node:fs';
import path from 'node:path';
import { KEY_LEN, openGcm, randomKey, sealGcm } from '../crypto/primitives.js';
import type { Repo } from '../db/repo.js';

/** Digits of a phone number as typed or stored ("+90 555 999 00 01", "0090…" → "905559990001"); null when it can't be one. */
export function normalizePhone(v: string): string | null {
  const digits = v.replace(/\D/g, '').replace(/^00/, '');
  return /^[1-9]\d{4,19}$/.test(digits) ? digits : null;
}

/** Phone digits of a phone-number JID ("905551112233@c.us"); null for LIDs and everything that is not a person. */
export function phoneDigits(id: string): string | null {
  return /^(\d{5,20})@(c\.us|s\.whatsapp\.net)$/.exec(id)?.[1] ?? null;
}

const isPersonId = (id: string): boolean => /@(c\.us|s\.whatsapp\.net|lid)$/.test(id);

export interface DirectoryEntry {
  phone: string;
  label: string | null;
}

/**
 * The admin's per-user block list, matched by phone number (never by name, which the person can change at will).
 *
 * The user's own data is sealed to the user, so the admin cannot read contact names from it. To let the admin pick
 * contacts anyway, the worker keeps a small separate directory (WhatsApp id → phone number, plus a label sealed with a
 * key file next to the database). That is a deliberate, narrow exception: names and numbers only, never messages.
 * It also lets a LID id ("…@lid", which hides the number) be matched without asking the WhatsApp page.
 */
export class BlockList {
  private phones = new Set<string>();
  private readonly lidPhones = new Map<string, string>();
  private key: Buffer | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly dataDir: string,
  ) {
    this.reload();
  }

  reload(): void {
    this.phones = new Set(this.repo.listBlocked());
  }

  /** Nothing is blocked: every check can be skipped. */
  get active(): boolean {
    return this.phones.size > 0;
  }

  list(): string[] {
    return [...this.phones];
  }

  replace(phones: string[]): void {
    this.repo.setBlocked(phones, Date.now());
    this.reload();
  }

  /** The phone number behind a WhatsApp id, as far as it is known without asking the page. */
  phoneOf(id: string | null | undefined): string | null {
    if (!id) return null;
    const pn = phoneDigits(id);
    if (pn) return pn;
    if (!id.endsWith('@lid')) return null;
    const cached = this.lidPhones.get(id);
    if (cached) return cached;
    const stored = this.repo.getDirectoryPhone(id);
    if (stored) this.lidPhones.set(id, stored);
    return stored;
  }

  /** True when [id] is a blocked person (a LID whose number is not known yet counts as not blocked: see [unresolved]). */
  blocks(id: string | null | undefined): boolean {
    if (!this.active || !id) return false;
    const p = this.phoneOf(id);
    return !!p && this.phones.has(p);
  }

  /** A person id whose number is unknown: while anything is blocked it can't be cleared, so callers decide how to treat it. */
  unresolved(id: string | null | undefined): boolean {
    return this.active && !!id && id.endsWith('@lid') && !this.phoneOf(id);
  }

  /* ------------------------------------------------------------------ directory */

  private dirKey(): Buffer {
    if (this.key) return this.key;
    const file = path.join(this.dataDir, 'directory.key');
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
    if (this.key.length !== KEY_LEN) throw new Error('bad directory key');
    return this.key;
  }

  /** Remembers who a WhatsApp id is (number and display label) for the admin's contact list. */
  record(id: string, phone: string | null, label: string | null): void {
    if (!isPersonId(id)) return;
    const digits = phone ? normalizePhone(phone) : phoneDigits(id);
    const clean = label?.trim().slice(0, 100) || null;
    if (!digits && !clean) return;
    this.repo.upsertDirectory({
      id,
      phone: digits,
      label_enc: clean ? sealGcm(this.dirKey(), Buffer.from(clean, 'utf8'), `wal/dir|${id}`) : null,
      now: Date.now(),
    });
    if (digits && id.endsWith('@lid')) this.lidPhones.set(id, digits);
  }

  /** Everyone the admin can pick: one entry per phone number, with the best label known. */
  directory(): DirectoryEntry[] {
    const byPhone = new Map<string, string | null>();
    for (const row of this.repo.listDirectory()) {
      if (!row.phone) continue;
      let label: string | null = null;
      if (row.label_enc) {
        try {
          label = openGcm(this.dirKey(), row.label_enc, `wal/dir|${row.id}`).toString('utf8');
        } catch {
          label = null;
        }
      }
      if (!byPhone.has(row.phone) || (!byPhone.get(row.phone) && label)) byPhone.set(row.phone, label);
    }
    // Chats logged before the directory existed: their id carries the number, only the name is missing.
    for (const id of this.repo.listUserChatIds()) {
      const p = phoneDigits(id);
      if (p && !byPhone.has(p)) byPhone.set(p, null);
    }
    for (const p of this.phones) if (!byPhone.has(p)) byPhone.set(p, null);
    return [...byPhone].map(([phone, label]) => ({ phone, label }));
  }
}
