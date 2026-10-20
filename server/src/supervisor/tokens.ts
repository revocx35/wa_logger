import crypto from 'node:crypto';

/*
 * Bearer tokens for the chromium manager (chromium/manager/auth.go derives the same ones; both sides are pinned to the
 * same test vectors). Only the supervisor knows the control secret: a tenant worker gets the token of its own
 * instance and cannot compute anyone else's.
 */

export function deriveToken(secret: string, label: string): string {
  return crypto.createHmac('sha256', secret).update(label).digest('hex');
}

export const instanceToken = (secret: string, id: number): string => deriveToken(secret, `wal/chromium/instance/${id}`);
export const adminToken = (secret: string): string => deriveToken(secret, 'wal/chromium/admin');
