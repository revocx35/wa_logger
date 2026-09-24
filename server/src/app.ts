import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './api/admin.js';
import { registerChatRoutes } from './api/chats.js';
import { registerEventRoutes } from './api/events.js';
import { registerMediaRoutes } from './api/media.js';
import { registerStateRoutes } from './api/state.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { Config } from './config.js';
import { AppContext, type WaController } from './context.js';
import { openDb } from './db/db.js';
import { Repo } from './db/repo.js';
import { EventBus } from './events.js';
import { buildServer } from './http/server.js';
import type { Logger } from './log.js';
import { SettingsStore } from './settings.js';
import { registerVncRoutes } from './vnc/bridge.js';

export interface BuiltApp {
  ctx: AppContext;
  app: FastifyInstance;
}

/** Composition root shared by index.ts and tests. The WhatsApp controller is attached by the caller. */
export async function createApp(
  config: Config,
  log: Logger,
  opts: { wa?: (ctx: AppContext) => WaController; routes?: (app: FastifyInstance, ctx: AppContext) => void } = {},
): Promise<BuiltApp> {
  const db = openDb(config.dbPath);
  const repo = new Repo(db);
  const ctx = new AppContext(config, log, repo, new EventBus(), new SettingsStore(repo, config.defaults));
  if (opts.wa) ctx.wa = opts.wa(ctx);
  const app = await buildServer(ctx);
  registerStateRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerVncRoutes(app, ctx);
  opts.routes?.(app, ctx);
  app.addHook('onClose', async () => {
    await ctx.wa.stop();
    ctx.writer()?.dispose();
    db.close();
  });
  return { ctx, app };
}
