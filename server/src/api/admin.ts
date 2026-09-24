import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditEntry, Settings } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { derivePasswordKeys, PASSWORD_MAX } from '../crypto/password.js';
import { ctEqual } from '../crypto/primitives.js';
import { AppError, Errors } from '../errors.js';
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
    const { password } = z.object({ password: z.string().min(1).max(PASSWORD_MAX) }).parse(req.body);
    const owner = repo.getOwner();
    if (!owner) throw Errors.unauthorized();
    const keys = await derivePasswordKeys(password, owner.pw_salt, config.scryptLogN);
    keys.kek.fill(0);
    if (!ctEqual(keys.authHash, owner.pw_auth_hash)) {
      repo.audit('wipe_failed', req.ip);
      throw new AppError(401, 'invalid_password', 'Password is incorrect.');
    }
    const paths = repo.wipeLoggedData();
    ctx.wa.onDataWiped();
    await fs.rm(config.mediaDir, { recursive: true, force: true });
    await fs.mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
    repo.db.pragma('wal_checkpoint(TRUNCATE)');
    repo.db.exec('VACUUM');
    repo.audit('data_wiped', req.ip, `${paths.length} media files`);
    return { ok: true };
  });
}
