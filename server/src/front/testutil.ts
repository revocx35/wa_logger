import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createLogger } from '../log.js';
import type { WorkerHandle } from '../supervisor/protocol.js';
import { registerAdminRoutes } from './admin.js';
import { registerFrontAuthRoutes } from './auth.js';
import type { FrontConfig } from './config.js';
import { openSystemDb, SystemRepo } from './db.js';
import { buildGateway, listenDefault, type BuiltGateway } from './gateway.js';
import type { WorkerPool } from './pool.js';

interface TestWorker {
  app: FastifyInstance;
  ctx: AppContext;
  handle: WorkerHandle;
  dataDir: string;
}

/** Real tenant workers (the same createApp the worker process runs) on unix sockets, in this process. */
export class InProcessPool implements WorkerPool {
  readonly workers = new Map<number, TestWorker>();
  readonly removed: number[] = [];
  readonly browserResets: number[] = [];
  private readonly starting = new Map<number, Promise<WorkerHandle>>();

  constructor(readonly root: string) {}

  cached(tenant: number): WorkerHandle | undefined {
    return this.workers.get(tenant)?.handle;
  }

  ensure(tenant: number): Promise<WorkerHandle> {
    const w = this.workers.get(tenant);
    if (w) return Promise.resolve(w.handle);
    let p = this.starting.get(tenant);
    if (!p) {
      p = this.start(tenant).finally(() => this.starting.delete(tenant));
      this.starting.set(tenant, p);
    }
    return p;
  }

  private async start(tenant: number): Promise<WorkerHandle> {
    const dataDir = path.join(this.root, String(tenant));
    const socketPath = path.join(this.root, `w${tenant}.sock`);
    const internalToken = crypto.randomBytes(32).toString('hex');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      SOCKET_PATH: socketPath,
      INTERNAL_TOKEN: internalToken,
      TENANT_ID: String(tenant),
      CHROMIUM_INSTANCE: String(tenant),
      SCRYPT_LOG_N: '10',
      WA_ENABLED: 'false',
      TRUST_PROXY: '1',
      COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
    });
    const { app, ctx } = await createApp(config, createLogger('silent'));
    fs.rmSync(socketPath, { force: true });
    await app.listen({ path: socketPath });
    const handle = { socketPath, internalToken };
    this.workers.set(tenant, { app, ctx, handle, dataDir });
    return handle;
  }

  async stop(tenant: number): Promise<void> {
    const w = this.workers.get(tenant);
    this.workers.delete(tenant);
    await w?.app.close();
  }

  async remove(tenant: number): Promise<void> {
    await this.stop(tenant);
    fs.rmSync(path.join(this.root, String(tenant)), { recursive: true, force: true });
    this.removed.push(tenant);
  }

  async resetBrowser(tenant: number): Promise<void> {
    this.browserResets.push(tenant);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.workers.keys()]) await this.stop(id);
  }
}

export const SETUP = 'gateway-setup-token-0123456789';

export interface TestGateway extends BuiltGateway {
  pool: InProcessPool;
  repo: SystemRepo;
  port: number;
  config: FrontConfig;
  root: string;
  close(): Promise<void>;
}

export async function makeGateway(over: Partial<FrontConfig> = {}): Promise<TestGateway> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));
  const config: FrontConfig = {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(root, 'system'),
    dbPath: path.join(root, 'system.db'),
    webDir: undefined,
    publicOrigin: undefined,
    setupToken: SETUP,
    cookieSecure: false,
    trustProxy: 0,
    sessionMaxMs: 7 * 86400_000,
    extraPorts: [],
    maxUsers: 10,
    controlSocket: path.join(root, 'ctl.sock'),
    chromiumHost: 'chromium',
    logLevel: 'silent',
    scryptLogN: 10,
    ...over,
  };
  const repo = new SystemRepo(openSystemDb(config.dbPath));
  const pool = new InProcessPool(root);
  const built = await buildGateway(config, repo, pool, createLogger('silent'));
  registerFrontAuthRoutes(built.app, built.gw);
  registerAdminRoutes(built.app, built.gw);
  const port = await listenDefault(built, { host: '127.0.0.1', port: 0 });
  return {
    ...built,
    pool,
    repo,
    port,
    config,
    root,
    close: async () => {
      await built.app.close();
      await pool.closeAll();
      repo.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export { Browser, type BrowserRes } from '../testutil/browser.js';
