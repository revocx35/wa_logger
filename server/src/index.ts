import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { WaService } from './wa/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  fs.mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });

  if (config.cookieSecure === false) log.warn('COOKIE_SECURE=false — session cookies are sent over plain HTTP. Use only for local development.');
  if (config.cookieSecure === 'auto') log.info('COOKIE_SECURE=auto — cookies are Secure when requests arrive over HTTPS (external reverse proxy).');
  if (!config.publicOrigin) log.warn('PUBLIC_ORIGIN is not set — Origin checks fall back to the request Host header.');

  const { app, ctx } = await createApp(config, log, { wa: (c) => new WaService(c) });

  // Periodic cleanup of expired sessions.
  const sweep = setInterval(() => ctx.repo.deleteExpiredSessions(Date.now(), config.sessionIdleMs), 10 * 60_000);
  sweep.unref();

  await app.listen({ host: config.host, port: config.port });
  if (ctx.repo.hasOwner()) await ctx.wa.start();
  else log.info('No owner yet — open the web UI and sign up with the SETUP_TOKEN from .env.');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
}

main().catch((err: unknown) => {
  // Config errors are safe to print; they never contain secret values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
