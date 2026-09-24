import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppState } from '../../../shared/api.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { AppContext, WaController } from '../context.js';
import { createLogger } from '../log.js';

export const ORIGIN = 'https://wal.test';
export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const PASSWORD = 'correct-horse-battery-staple';

export interface Res {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

/** A tiny cookie-jar HTTP client over fastify.inject that behaves like a same-origin browser. */
export class TestClient {
  cookie = '';
  csrf = '';

  constructor(private readonly app: FastifyInstance) {}

  async req(
    method: string,
    url: string,
    body?: unknown,
    opts: { origin?: string | null; csrf?: string | null; headers?: Record<string, string> } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (this.cookie) headers.cookie = this.cookie;
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await this.app.inject({
      method: method as 'GET',
      url,
      headers,
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers['set-cookie'];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = c.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (!name) continue;
      if (!value || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookie = '';
      else this.cookie = `${name}=${value}`;
    }
    let parsed: unknown = undefined;
    try {
      parsed = r.body ? JSON.parse(r.body) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: r.statusCode, body: parsed, headers: r.headers as Res['headers'], raw: r.body };
  }

  async refreshState(): Promise<AppState> {
    const r = await this.req('GET', '/api/state');
    this.csrf = r.body?.csrfToken ?? '';
    return r.body as AppState;
  }

  async signup(username = 'owner', password = PASSWORD): Promise<string> {
    const r = await this.req('POST', '/api/auth/signup', { setupToken: SETUP_TOKEN, username, password });
    if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${r.raw}`);
    await this.refreshState();
    return r.body.recoveryKey as string;
  }

  async login(username = 'owner', password = PASSWORD, totp?: string): Promise<Res> {
    const r = await this.req('POST', '/api/auth/login', { username, password, ...(totp ? { totp } : {}) });
    if (r.status === 200) await this.refreshState();
    return r;
  }
}

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  client: () => TestClient;
  close: () => Promise<void>;
}

export async function makeHarness(
  env: Record<string, string> = {},
  opts: { wa?: (ctx: AppContext) => WaController; routes?: (app: FastifyInstance, ctx: AppContext) => void } = {},
): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    SETUP_TOKEN,
    VNC_PASSWORD: 'vnc-pass-123',
    SCRYPT_LOG_N: '10',
    WA_ENABLED: 'false',
    PUBLIC_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    ...env,
  });
  const { app, ctx } = await createApp(config, createLogger('silent'), opts);
  await app.ready();
  return {
    app,
    ctx,
    dir,
    client: () => new TestClient(app),
    close: async () => {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
