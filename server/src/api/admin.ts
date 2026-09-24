import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditEntry, Settings } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { verifyOwnerSecret } from '../auth/routes.js';
import { sessionPrivateKey } from '../auth/sessions.js';
import { PASSWORD_MAX } from '../crypto/password.js';
import { AppError, Errors } from '../errors.js';
import { requireSession } from '../http/server.js';
import { SettingsSchema } from '../settings.js';

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, config } = ctx;

  /* ------------------------------------------------------------ WhatsApp */
  app.get('/api/wa/status', async () => ctx.wa.status());

  app.post('/api/wa/restart', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req) => {
    repo.audit('wa_restart', req.ip);
    await ctx.wa.restart();
    return { ok: true };
  });

  app.post('/api/wa/logout', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (req) => {
    repo.audit('wa_logout', req.ip);
    try {
      await ctx.wa.logout();
    } catch {
      throw Errors.unavailable('WhatsApp is not connected.');
    }
    return { ok: true };
  });

  /* ------------------------------------------------------------ settings */
  app.get('/api/settings', async () => ctx.settings.get());

  app.put('/api/settings', async (req) => {
    const patch = SettingsSchema.partial().strict().parse(req.body);
    const next: Settings = ctx.settings.update(patch);
    repo.audit('settings_changed', req.ip, Object.keys(patch).join(','));
    return next;
  });

  /* --------------------------------------------------------------- audit */
  app.get('/api/audit', async (req) => {
    const q = z
      .object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const rows: AuditEntry[] = repo.listAudit(q.limit, q.before);
    return rows;
  });

  /* ---------------------------------------------------------------- wipe */
  app.post('/api/data/wipe', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const s = requireSession(req);
    const { password, totp } = z
      .object({ password: z.string().min(1).max(PASSWORD_MAX), totp: z.string().max(12).optional() })
      .parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    // Password (and the 2FA code when enabled) — throttled like a login.
    const check = await verifyOwnerSecret(ctx, req, owner, password, totp, () => sessionPrivateKey(s));
    check.kek?.fill(0);
    if (!check.ok) {
      repo.audit('wipe_failed', req.ip);
      throw new AppError(401, 'invalid_password', owner.totp_enabled ? 'Invalid password or authentication code.' : 'Password is incorrect.');
    }
    const paths = repo.wipeLoggedData();
    ctx.wa.onDataWiped();
    await fs.rm(config.mediaDir, { recursive: true, force: true });
    await fs.mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
    repo.db.exec('VACUUM');
    repo.scrub();
    repo.audit('data_wiped', req.ip, `${paths.length} media files`);
    return { ok: true };
  });
}
