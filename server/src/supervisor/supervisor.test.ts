import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { Supervisor, type SupervisorConfig } from './supervisor.js';
import { adminToken, instanceToken } from './tokens.js';

// Pinned to the same vectors as chromium/manager/manager_test.go (TestTokenVectors).
describe('chromium manager tokens', () => {
  it('match the Go implementation', () => {
    expect(instanceToken('testsecret-0123456789', 1)).toBe('af32b993f73045e8bec51dc96ecc7e9acbbce97cc660fc59f1921c9776da61b4');
    expect(instanceToken('testsecret-0123456789', 42)).toBe('abfb541b0c05f1b614fb1b873b0ea66adb2899b988896c8fae8d1cf72ac69d9b');
    expect(adminToken('testsecret-0123456789')).toBe('13215f4dc7bdb42e0431274d3f633d8b18e140d96778be5dac054e858fd256f4');
  });
});

// A stand-in worker: listens on SOCKET_PATH and reports its environment when asked.
const FAKE_WORKER = `
const CRASH_ONCE_FILE = __CRASH__;
const net = require('node:net'), fs = require('node:fs');
fs.rmSync(process.env.SOCKET_PATH, { force: true });
const s = net.createServer((c) => { c.on('error', () => {}); c.end(JSON.stringify({ env: process.env, argv: process.argv.slice(2) })); });
s.listen(process.env.SOCKET_PATH);
process.on('SIGTERM', () => process.exit(0));
if (CRASH_ONCE_FILE && !fs.existsSync(CRASH_ONCE_FILE)) { fs.writeFileSync(CRASH_ONCE_FILE, '1'); setTimeout(() => process.exit(3), 300); }
`;

function ask(sock: string): Promise<{ env: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let out = '';
    const c = net.connect(sock);
    c.on('data', (d) => (out += d));
    c.on('end', () => resolve(JSON.parse(out)));
    c.on('error', reject);
  });
}

function control(sock: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let out = '';
    c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => {
      out += d;
      if (out.includes('\n')) {
        c.end();
        resolve(JSON.parse(out));
      }
    });
    c.on('error', reject);
  });
}

describe('supervisor', () => {
  let dir: string;
  let sup: Supervisor;
  const crashFile = () => path.join(dir, 'crashed');

  beforeEach(() => {
    // Unix socket paths are limited to ~100 bytes: keep the directory short.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
    fs.writeFileSync(path.join(dir, 'worker.cjs'), FAKE_WORKER.replace('__CRASH__', 'null'));
    fs.writeFileSync(path.join(dir, 'front.cjs'), 'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0));');
    fs.mkdirSync(path.join(dir, 'data'));
  });
  afterEach(async () => {
    await sup?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make(extra: Partial<SupervisorConfig> = {}): Supervisor {
    const cfg: SupervisorConfig = {
      controlSecret: 'control-secret-0123456789',
      dataDir: path.join(dir, 'data'),
      usersDir: path.join(dir, 'users'),
      runDir: path.join(dir, 'run'),
      frontUid: 10003,
      legacyUid: 10001,
      uidBase: 10100,
      chromiumUrl: 'http://chromium:9223',
      dropPrivileges: false,
      workerCommand: [process.execPath, path.join(dir, 'worker.cjs')],
      frontCommand: [process.execPath, path.join(dir, 'front.cjs')],
      env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', SETUP_TOKEN: 'secret-setup-token-xyz', CONTROL_SECRET: 'must-not-leak', COOKIE_SECURE: 'auto', MEDIA_MAX_MB: '5' },
      workerReadyTimeoutMs: 10_000,
      ...extra,
    };
    sup = new Supervisor(cfg, createLogger('silent'));
    return sup;
  }

  it('starts a worker per tenant with a minimal environment of its own', async () => {
    make();
    await sup.start();
    const w1 = await sup.ensureWorker(1);
    const w2 = await sup.ensureWorker(2);
    expect(w1.internalToken).not.toBe(w2.internalToken);
    expect(w1.internalToken).toMatch(/^[0-9a-f]{64}$/);
    expect(w1.socketPath).not.toBe(w2.socketPath);

    const e1 = (await ask(w1.socketPath)).env;
    const e2 = (await ask(w2.socketPath)).env;
    expect(e1.DATA_DIR).toBe(path.join(dir, 'data'));
    expect(e2.DATA_DIR).toBe(path.join(dir, 'users', '2'));
    expect(e2.TENANT_ID).toBe('2');
    expect(e2.CHROMIUM_INSTANCE).toBe('2');
    // Each worker gets its own browser token and nobody else's.
    expect(e1.CHROMIUM_TOKEN).toBe(instanceToken('control-secret-0123456789', 1));
    expect(e2.CHROMIUM_TOKEN).toBe(instanceToken('control-secret-0123456789', 2));
    expect(e2.INTERNAL_TOKEN).toBe(w2.internalToken);
    // Nothing from the supervisor's environment leaks: no control secret, no setup token.
    for (const e of [e1, e2]) {
      expect(JSON.stringify(e)).not.toContain('control-secret-0123456789');
      expect(JSON.stringify(e)).not.toContain('must-not-leak');
      expect(JSON.stringify(e)).not.toContain('secret-setup-token-xyz');
      expect(e.SETUP_TOKEN).toBeUndefined();
      expect(e.TRUST_PROXY).toBe('1');
      expect(e.MEDIA_MAX_MB).toBe('5');
    }
    expect(Object.keys(sup.status()).sort()).toEqual(['1', '2']);
  });

  it('keeps the same token when it restarts a crashed worker', async () => {
    fs.writeFileSync(path.join(dir, 'worker.cjs'), FAKE_WORKER.replace('__CRASH__', JSON.stringify(crashFile())));
    make();
    await sup.start();
    const w = await sup.ensureWorker(2);
    await new Promise((r) => setTimeout(r, 2500)); // crashes after 300 ms, restarts after 2 s of backoff
    expect(fs.existsSync(crashFile())).toBe(true);
    const again = await sup.ensureWorker(2);
    expect(again.internalToken).toBe(w.internalToken);
    expect((await ask(again.socketPath)).env.TENANT_ID).toBe('2');
    expect(sup.status()['2']!.restarts).toBeGreaterThan(0);
  }, 20_000);

  it('serves the control protocol on a socket and rejects bad requests', async () => {
    make();
    await sup.start();
    const sock = sup.controlSocketPath();
    expect((await control(sock, { rid: 1, op: 'spawn', tenant: 3 })).socketPath).toBe(sup.socketPathFor(3));
    expect(await control(sock, { rid: 2, op: 'spawn', tenant: 0 })).toMatchObject({ ok: false });
    expect(await control(sock, { rid: 3, op: 'spawn', tenant: 10000 })).toMatchObject({ ok: false });
    expect(await control(sock, { rid: 4, op: 'spawn', tenant: '../etc' })).toMatchObject({ ok: false });
    expect(await control(sock, { rid: 5, op: 'rm -rf', tenant: 3 })).toMatchObject({ ok: false });
    const st = await control(sock, { rid: 6, op: 'status' });
    expect(st.workers['3'].running).toBe(true);
    expect(await control(sock, { rid: 7, op: 'stop', tenant: 3 })).toMatchObject({ ok: true });
    expect((await control(sock, { rid: 8, op: 'status' })).workers['3'].running).toBe(false);
  });

  it('removes a tenant: stops it, deletes its directories, and refuses the first account', async () => {
    make();
    await sup.start();
    await sup.ensureWorker(2);
    fs.writeFileSync(path.join(dir, 'users', '2', 'wa_logger.db'), 'x');
    // The chromium container is not there in this test: the browser removal fails but must not block the rest.
    await sup.removeTenant(2);
    expect(fs.existsSync(path.join(dir, 'users', '2'))).toBe(false);
    expect(fs.existsSync(sup.socketDirFor(2))).toBe(false);
    expect(sup.status()['2']).toBeUndefined();
    await expect(sup.removeTenant(1)).rejects.toThrow(/first account/);
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(true);
  });
});
