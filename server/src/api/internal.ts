import fs from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { derivePasswordKeys, newSalt, PASSWORD_MAX } from '../crypto/password.js';
import { Errors } from '../errors.js';

const Username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, 'Username must be 3–32 characters: letters, digits, dot, dash, underscore.');
const Password = z.string().min(1).max(PASSWORD_MAX);

/**
 * Routes only the gateway calls (the gateway is the multi-user front: it owns the user list, the ports and the admin
 * UI; this tenant worker owns one user's keys and data). They exist only when INTERNAL_TOKEN is set, and the server
 * hook refuses every request without that token, so a browser can never reach them: the gateway forwards nothing
 * under /internal from the outside.
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: { createAccount: (req: FastifyRequest, reply: FastifyReply, username: string, password: string) => Promise<{ recoveryKey: string }> },
): void {
  if (!ctx.config.internalToken) return;
  const { repo, config } = ctx;
  const cfg = { config: { public: true, skipCsrf: true } };

  app.get('/internal/info', cfg, async () => {
    const owner = repo.getOwner();
    const pending = repo.getPendingClaim();
    return {
      hasOwner: !!owner,
      username: owner?.username ?? pending?.username ?? null,
      pending: pending?.mode ?? null,
      totpEnabled: !!owner?.totp_enabled,
      wa: ctx.wa.status().state,
      onboardingComplete: repo.getState('onboarding_complete') === '1',
    };
  });

  /** The admin's own account: created with the password they chose (the gateway checked the setup token). */
  app.post('/internal/signup', cfg, async (req, reply) => {
    const body = z.object({ username: Username, password: Password }).parse(req.body);
    if (repo.hasOwner() || repo.getPendingClaim()) throw Errors.conflict('This account is already set up.');
    const res = await auth.createAccount(req, reply, body.username, body.password);
    repo.audit('signup', req.ip);
    return res;
  });

  /** A new account: the user claims it with this temporary password on first sign-in. */
  app.post('/internal/provision', cfg, async (req) => {
    const body = z.object({ username: Username, tempPassword: Password }).parse(req.body);
    if (repo.hasOwner()) throw Errors.conflict('This account is already set up.');
    const salt = newSalt();
    const keys = await derivePasswordKeys(body.tempPassword, salt, config.scryptLogN);
    keys.kek.fill(0);
    repo.setPendingClaim({ username: body.username, mode: 'new', salt, auth_hash: keys.authHash });
    repo.audit('provisioned', req.ip);
    return { ok: true };
  });

  /**
   * Password reset by the admin. 'recovery': the old password stops working; the user signs in with the new temporary
   * one and proves they hold the recovery key (the data stays). 'wipe': everything of this account is deleted and it
   * starts over like a new one (new keys, WhatsApp unlinked).
   */
  app.post('/internal/reset', cfg, async (req) => {
    const body = z.object({ mode: z.enum(['recovery', 'wipe']), tempPassword: Password }).parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.conflict('This account has not been claimed yet.');
    const salt = newSalt();
    const keys = await derivePasswordKeys(body.tempPassword, salt, config.scryptLogN);
    keys.kek.fill(0);
    if (body.mode === 'recovery') {
      repo.transaction(() => {
        repo.setPendingClaim({ username: owner.username, mode: 'reset', salt, auth_hash: keys.authHash });
        repo.deleteAllSessions();
      });
      repo.scrub();
      ctx.events.emit({ type: 'session_revoked' });
      repo.audit('reset_issued', req.ip, 'recovery');
      return { ok: true };
    }
    await ctx.wa.logout().catch(() => undefined);
    await ctx.wa.stop();
    const paths = repo.resetAccount();
    ctx.resetWriter();
    ctx.wa.onDataWiped();
    await fs.rm(config.mediaDir, { recursive: true, force: true });
    await fs.mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
    repo.setPendingClaim({ username: owner.username, mode: 'new', salt, auth_hash: keys.authHash });
    repo.db.exec('VACUUM');
    repo.scrub();
    ctx.events.emit({ type: 'session_revoked' });
    repo.audit('reset_issued', req.ip, `wipe, ${paths.length} media files`);
    return { ok: true };
  });

  app.post('/internal/revoke-sessions', cfg, async (req) => {
    const n = repo.deleteAllSessions();
    repo.scrub();
    ctx.events.emit({ type: 'session_revoked' });
    repo.audit('sessions_revoked_by_admin', req.ip, `${n} sessions`);
    return { ok: true, sessions: n };
  });

  /** Before the account is deleted: unlink the WhatsApp device and stop logging. */
  app.post('/internal/unlink', cfg, async () => {
    await ctx.wa.logout().catch(() => undefined);
    await ctx.wa.stop();
    return { ok: true };
  });
}
