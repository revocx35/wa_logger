import { loadFrontConfig } from './front/config.js';
import { openSystemDb, SystemRepo } from './front/db.js';
import { registerAdminRoutes } from './front/admin.js';
import { registerFrontAuthRoutes } from './front/auth.js';
import { buildGateway, listenDefault, type Gateway } from './front/gateway.js';
import { SupervisorPool } from './front/pool.js';
import { createLogger, type Logger } from './log.js';

/**
 * The gateway: the only process of the app container that listens on the network. It owns the list of users and the
 * ports, serves the web UI and the admin API, and forwards every other request to the signed-in user's worker over
 * a unix socket. It never sees a user's keys or data at rest; it runs as an unprivileged user of its own.
 */

/** Makes sure tenant 1 has a worker, adopts a pre-existing single-user account as the admin, and wakes everyone else. */
export async function bootstrap(gw: Gateway, log: Logger): Promise<void> {
  if (gw.repo.userCount() === 0) {
    // Either a fresh install, or an upgrade from a release without user management: whatever account tenant 1's data
    // directory holds becomes the admin.
    try {
      const r = await gw.callInternal({ id: 1 }, 'GET', '/internal/info');
      const info = r.status === 200 ? (JSON.parse(r.body.toString('utf8')) as { hasOwner: boolean; username: string | null }) : null;
      if (info?.hasOwner && info.username) {
        gw.repo.createUser({ id: 1, username: info.username, role: 'admin', port: null });
        gw.repo.audit('admin_adopted', null, { target: 1, detail: 'existing single-user account' });
        log.info('adopted the existing account as the admin');
      } else {
        log.info('No account yet — open the web UI and sign up with the SETUP_TOKEN from .env.');
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not reach the first worker');
    }
  }
  for (const l of gw.repo.listListeners()) {
    await gw.listeners.open(l.port).catch((err: unknown) => log.warn({ port: l.port, err: err instanceof Error ? err.message : String(err) }, 'could not open a saved port'));
  }
  // Everyone's logger runs around the clock, signed in or not.
  await Promise.all(
    gw.repo.listUsers().map((u) =>
      gw.pool.ensure(u.id).catch((err: unknown) => log.warn({ tenant: u.id, err: err instanceof Error ? err.message : String(err) }, 'worker did not start')),
    ),
  );
}

async function main(): Promise<void> {
  const config = loadFrontConfig();
  const log = createLogger(config.logLevel);
  if (config.cookieSecure === false) log.warn('COOKIE_SECURE=false — session cookies are sent over plain HTTP. Use only for local development.');
  if (config.cookieSecure === 'auto') log.info('COOKIE_SECURE=auto — cookies are Secure when requests arrive over HTTPS (external reverse proxy).');
  if (!config.publicOrigin) log.warn('PUBLIC_ORIGIN is not set — Origin checks fall back to the request Host header.');

  const repo = new SystemRepo(openSystemDb(config.dbPath));
  const built = await buildGateway(config, repo, new SupervisorPool(config.controlSocket), log);
  registerFrontAuthRoutes(built.app, built.gw);
  registerAdminRoutes(built.app, built.gw);
  await listenDefault(built, { host: config.host, port: config.port });
  await bootstrap(built.gw, log);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await built.app.close();
    } finally {
      repo.db.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
}

if (process.argv[1] && /front\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
