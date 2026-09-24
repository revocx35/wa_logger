import type { Repo } from '../db/repo.js';
import { Errors } from '../errors.js';

/*
 * Brute-force throttling for every credential check (password, TOTP, recovery key).
 *
 * - Each attempt is *charged before* the slow scrypt runs, synchronously (better-sqlite3 is
 *   synchronous, so there is no await between the check and the write). Parallel requests therefore
 *   cannot race past the lock; a success afterwards refunds by resetting the counters.
 * - Per-IP: after IP_THRESHOLD failures an IP gets exponentially growing locks (30 s … 1 h).
 *   A single attacker cannot lock the owner out, because the owner's IP has its own counter.
 * - Global (per account, persisted in the DB): after GLOBAL_THRESHOLD consecutive failures across all
 *   IPs, the account allows only one attempt per lock period (30 s … 15 min). This bounds distributed
 *   guessing to roughly a hundred attempts per day.
 */

const IP_THRESHOLD = 5;
const IP_BASE_MS = 30_000;
const IP_MAX_MS = 60 * 60_000;
const GLOBAL_THRESHOLD = 50;
const GLOBAL_BASE_MS = 30_000;
const GLOBAL_MAX_MS = 15 * 60_000;
const IP_ENTRY_TTL_MS = 24 * 3600_000;

interface IpState {
  fails: number;
  lockedUntil: number;
  last: number;
}

export interface Attempt {
  ip: string;
  global: boolean;
}

function backoff(n: number, threshold: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, n - threshold - 1), max);
}

export class Throttle {
  private readonly ips = new Map<string, IpState>();

  constructor(private readonly repo: Repo) {}

  /**
   * Charges one attempt. Throws a 429 AppError when the IP or (for `global`) the account is locked.
   * `global` should be true for password/TOTP guesses; recovery keys (256-bit) only use the IP limit.
   */
  begin(ip: string | null | undefined, opts: { global: boolean }, now = Date.now()): Attempt {
    const key = ip || 'unknown';
    this.prune(now);
    let st = this.ips.get(key) ?? { fails: 0, lockedUntil: 0, last: now };
    // Old failures from a quiet IP decay after a day.
    if (st.lockedUntil <= now && now - st.last > IP_ENTRY_TTL_MS) st = { fails: 0, lockedUntil: 0, last: now };
    if (st.lockedUntil > now) throw Errors.rateLimited((st.lockedUntil - now) / 1000);

    if (opts.global) {
      const owner = this.repo.getOwner();
      if (owner) {
        if (owner.locked_until && owner.locked_until > now) throw Errors.rateLimited((owner.locked_until - now) / 1000);
        const n = owner.failed_logins + 1;
        this.repo.updateOwner({
          failed_logins: n,
          locked_until: n > GLOBAL_THRESHOLD ? now + backoff(n, GLOBAL_THRESHOLD, GLOBAL_BASE_MS, GLOBAL_MAX_MS) : owner.locked_until,
        });
      }
    }

    st.fails += 1;
    st.last = now;
    if (st.fails > IP_THRESHOLD) st.lockedUntil = now + backoff(st.fails, IP_THRESHOLD, IP_BASE_MS, IP_MAX_MS);
    this.ips.set(key, st);
    return { ip: key, global: opts.global };
  }

  /** Credentials were fully verified: clear the counters charged by this attempt. */
  success(a: Attempt): void {
    this.ips.delete(a.ip);
    if (a.global) this.repo.updateOwner({ failed_logins: 0, locked_until: null });
  }

  private prune(now: number): void {
    if (this.ips.size < 5000) return;
    for (const [k, v] of this.ips) if (now - v.last > IP_ENTRY_TTL_MS && v.lockedUntil < now) this.ips.delete(k);
  }
}
