import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createLogger } from '../log.js';
import { Supervisor, type SupervisorConfig } from './supervisor.js';

/** Entry point of the app container: `node dist/supervisor/main.js` (runs as root with CAP_SETUID/SETGID/CHOWN only). */
const Env = z.object({
  CONTROL_SECRET: z.string().min(8, 'CONTROL_SECRET must be at least 8 characters'),
  DATA_DIR: z.string().default('/data'),
  USERS_DIR: z.string().default('/users'),
  RUN_DIR: z.string().default('/run/wal'),
  FRONT_UID: z.coerce.number().int().min(1000).default(10003),
  LEGACY_UID: z.coerce.number().int().min(1000).default(10001),
  UID_BASE: z.coerce.number().int().min(1000).default(10100),
  CHROMIUM_URL: z.string().default('http://chromium:9223'),
  /** Node heap cap per tenant worker: a runaway one is stopped (and restarted) instead of taking the container's memory. */
  WORKER_HEAP_MB: z.coerce.number().int().min(128).max(8192).default(768),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

async function main(): Promise<void> {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
    process.exit(1);
  }
  const e = parsed.data;
  const log = createLogger(e.LOG_LEVEL);
  // dist/supervisor/main.js → dist/ (the children run with cwd / so the paths must be absolute)
  const dist = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const env = { ...process.env };
  delete env.CONTROL_SECRET; // never inherited by the front or a worker
  const cfg: SupervisorConfig = {
    controlSecret: e.CONTROL_SECRET,
    dataDir: e.DATA_DIR,
    usersDir: e.USERS_DIR,
    runDir: e.RUN_DIR,
    frontUid: e.FRONT_UID,
    legacyUid: e.LEGACY_UID,
    uidBase: e.UID_BASE,
    chromiumUrl: e.CHROMIUM_URL,
    dropPrivileges: process.getuid?.() === 0,
    workerCommand: [process.execPath, '--disable-proto=delete', `--max-old-space-size=${e.WORKER_HEAP_MB}`, path.join(dist, 'index.js')],
    frontCommand: [process.execPath, '--disable-proto=delete', path.join(dist, 'front.js')],
    env,
    workerReadyTimeoutMs: 30_000,
  };
  if (!cfg.dropPrivileges) log.warn('not running as root: every process keeps this user (development only)');
  const sup = new Supervisor(cfg, log);
  await sup.start();
  const stop = () => void sup.shutdown().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
