import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from '../log.js';
import { MAX_TENANT, MIN_TENANT, validTenant, type ControlRequest, type ControlResponse, type WorkerHandle } from './protocol.js';
import { adminToken, instanceToken } from './tokens.js';

/*
 * The supervisor is the only process of the app container that runs as root, and it does nothing but this: create each
 * tenant's directories, start the gateway ("front", the only process that listens on the network) and one worker per
 * tenant under that tenant's own unix user, and restart them when they die. It has no network listener and parses
 * nothing but the one-line JSON of its control socket, which only the front's unix user can open. It holds the
 * capabilities CAP_SETUID/SETGID/CHOWN and nothing else.
 */

export interface SupervisorConfig {
  controlSecret: string;
  dataDir: string; // tenant 1 (the first account) lives here, as in the single-user releases
  usersDir: string; // every other tenant: <usersDir>/<id>; the front's own data: <usersDir>/system
  runDir: string; // control socket and the workers' socket directories
  frontUid: number;
  legacyUid: number; // owner of dataDir
  uidBase: number; // tenant n (n > 1) runs as uidBase + n
  chromiumUrl: string;
  /** Switch users with setuid/setgid when started as root. Off in tests and development. */
  dropPrivileges: boolean;
  /** Command lines (overridable in tests). */
  workerCommand: string[];
  frontCommand: string[];
  /** Environment the front and the workers inherit selectively. */
  env: NodeJS.ProcessEnv;
  workerReadyTimeoutMs: number;
}

const WORKER_ENV_PASSTHROUGH = [
  'NODE_ENV',
  'LOG_LEVEL',
  'SESSION_IDLE_HOURS',
  'SESSION_MAX_DAYS',
  'MEDIA_MAX_MB',
  'HISTORY_PER_CHAT',
  'RECONCILE_MINUTES',
  'COOKIE_SECURE',
  'SCRYPT_LOG_N',
  'WA_ENABLED',
];

const FRONT_ENV_PASSTHROUGH = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'HOST',
  'PUBLIC_ORIGIN',
  'SETUP_TOKEN',
  'TRUST_PROXY',
  'COOKIE_SECURE',
  'EXTRA_PORTS',
  'MAX_USERS',
  'WEB_DIR',
  'SCRYPT_LOG_N',
  'LISTEN_BIND',
];

interface Worker {
  id: number;
  token: string;
  proc: ChildProcess | null;
  desired: boolean;
  restarts: number;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  exited: Promise<void> | null;
}

export class Supervisor {
  private readonly workers = new Map<number, Worker>();
  private front: { proc: ChildProcess | null; desired: boolean; timer: NodeJS.Timeout | null; restarts: number } = {
    proc: null,
    desired: false,
    timer: null,
    restarts: 0,
  };
  private control: net.Server | null = null;
  private shuttingDown = false;

  constructor(
    readonly cfg: SupervisorConfig,
    private readonly log: Logger,
  ) {}

  /* --------------------------------------------------------- layout */

  uidFor(id: number): number {
    return id === 1 ? this.cfg.legacyUid : this.cfg.uidBase + id;
  }

  dataDirFor(id: number): string {
    return id === 1 ? this.cfg.dataDir : path.join(this.cfg.usersDir, String(id));
  }

  socketDirFor(id: number): string {
    return path.join(this.cfg.runDir, 'w', String(id));
  }

  socketPathFor(id: number): string {
    return path.join(this.socketDirFor(id), 's.sock');
  }

  controlSocketPath(): string {
    return path.join(this.cfg.runDir, 'ctl', 'ctl.sock');
  }

  private chown(p: string, uid: number, gid: number): void {
    if (this.cfg.dropPrivileges) fs.chownSync(p, uid, gid);
  }

  /** Creates the directory with this mode and hands it over. (Once it belongs to another user root may not chmod it.) */
  private mkdir(p: string, mode: number, uid: number, gid: number): void {
    const created = fs.mkdirSync(p, { recursive: true, mode });
    if (created) fs.chmodSync(created === p ? p : p, mode); // beats the umask
    this.chown(p, uid, gid);
  }

  /* ----------------------------------------------------------- start */

  async start(): Promise<void> {
    const { runDir, usersDir, frontUid } = this.cfg;
    // Worker socket directories are closed to everyone but their tenant and the front's group (0710). The supervisor
    // joins that group so it can see when a worker is up; the processes it spawns drop all groups (setgid clears them).
    if (this.cfg.dropPrivileges) process.setgroups?.([frontUid]);
    // /run/wal: root-owned, everyone may traverse (the front needs to reach the sockets), nobody may list or write.
    this.mkdir(runDir, 0o711, 0, 0);
    this.mkdir(path.join(runDir, 'ctl'), 0o750, 0, frontUid);
    this.mkdir(path.join(runDir, 'w'), 0o711, 0, 0);
    // /users: root-owned and traversable; each tenant directory below belongs to that tenant alone.
    this.mkdir(usersDir, 0o711, 0, 0);
    this.mkdir(path.join(usersDir, 'system'), 0o700, frontUid, frontUid);
    await this.listenControl();
    this.startFront();
  }

  private listenControl(): Promise<void> {
    const sock = this.controlSocketPath();
    fs.rmSync(sock, { force: true });
    const server = net.createServer((conn) => this.onControlConnection(conn));
    this.control = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => {
        // The directory (root:front 0750) already keeps everyone else out; the socket itself is front-only as well.
        this.chown(sock, 0, this.cfg.frontUid);
        fs.chmodSync(sock, 0o660);
        resolve();
      });
    });
  }

  private onControlConnection(conn: net.Socket): void {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) return conn.destroy();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void this.handleLine(line).then((res) => {
          if (!conn.destroyed) conn.write(`${JSON.stringify(res)}\n`);
        });
      }
    });
    conn.on('error', () => undefined);
  }

  private async handleLine(line: string): Promise<ControlResponse> {
    let req: ControlRequest;
    try {
      req = JSON.parse(line) as ControlRequest;
    } catch {
      return { rid: 0, ok: false, error: 'bad request' };
    }
    const rid = typeof req?.rid === 'number' ? req.rid : 0;
    try {
      if (req.op === 'status') return { rid, ok: true, workers: this.status() };
      if (!validTenant(req.tenant)) return { rid, ok: false, error: 'bad tenant' };
      switch (req.op) {
        case 'spawn':
          return { rid, ok: true, ...(await this.ensureWorker(req.tenant)) };
        case 'stop':
          await this.stopWorker(req.tenant);
          return { rid, ok: true };
        case 'remove':
          await this.removeTenant(req.tenant);
          return { rid, ok: true };
        case 'reset-browser':
          await this.deleteBrowser(req.tenant);
          return { rid, ok: true };
        default:
          return { rid, ok: false, error: 'unknown op' };
      }
    } catch (err) {
      this.log.warn({ op: req.op, tenant: req.tenant, err: err instanceof Error ? err.message : String(err) }, 'control request failed');
      return { rid, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' };
    }
  }

  status(): Record<string, { running: boolean; restarts: number }> {
    const out: Record<string, { running: boolean; restarts: number }> = {};
    for (const w of this.workers.values()) out[String(w.id)] = { running: !!w.proc && w.proc.exitCode === null, restarts: w.restarts };
    return out;
  }

  /* --------------------------------------------------------- workers */

  private workerEnv(id: number, token: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
    for (const k of WORKER_ENV_PASSTHROUGH) if (this.cfg.env[k] !== undefined) env[k] = this.cfg.env[k];
    Object.assign(env, {
      // A tenant's unix user has no passwd entry, and Node's os.homedir() throws without HOME.
      HOME: this.dataDirFor(id),
      TENANT_ID: String(id),
      DATA_DIR: this.dataDirFor(id),
      SOCKET_PATH: this.socketPathFor(id),
      INTERNAL_TOKEN: token,
      CHROMIUM_URL: this.cfg.chromiumUrl,
      CHROMIUM_INSTANCE: String(id),
      CHROMIUM_TOKEN: instanceToken(this.cfg.controlSecret, id),
      // The only peer is the gateway, which hands over the real client address in X-Forwarded-For.
      TRUST_PROXY: '1',
    });
    return env;
  }

  private prepareTenant(id: number): void {
    const uid = this.uidFor(id);
    if (id !== 1) this.mkdir(this.dataDirFor(id), 0o700, uid, uid);
    // The socket directory: owned by the tenant (it creates its socket there), group = front, search-only for the group,
    // nothing for anyone else. A worker therefore cannot even reach another worker's socket.
    this.mkdir(this.socketDirFor(id), 0o710, uid, this.cfg.frontUid);
  }

  async ensureWorker(id: number): Promise<WorkerHandle> {
    if (this.shuttingDown) throw new Error('shutting down');
    let w = this.workers.get(id);
    if (!w) {
      w = { id, token: crypto.randomBytes(32).toString('hex'), proc: null, desired: true, restarts: 0, startedAt: 0, timer: null, exited: null };
      this.workers.set(id, w);
    }
    w.desired = true;
    if (!w.proc || w.proc.exitCode !== null) this.startWorker(w);
    await this.waitForSocket(id);
    return { socketPath: this.socketPathFor(id), internalToken: w.token };
  }

  private startWorker(w: Worker): void {
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    this.prepareTenant(w.id);
    const uid = this.uidFor(w.id);
    const [cmd, ...args] = this.cfg.workerCommand;
    const proc = spawn(cmd!, args, {
      env: this.workerEnv(w.id, w.token),
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: '/',
      ...(this.cfg.dropPrivileges ? { uid, gid: uid } : {}),
    });
    w.proc = proc;
    w.startedAt = Date.now();
    this.log.info({ tenant: w.id, pid: proc.pid }, 'worker started');
    w.exited = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        resolve();
        if (w.proc !== proc) return;
        w.proc = null;
        this.log.warn({ tenant: w.id, code, signal }, 'worker exited');
        if (!w.desired || this.shuttingDown) return;
        // Quick crash loops back off; a worker that ran for a minute starts fresh.
        w.restarts = Date.now() - w.startedAt > 60_000 ? 0 : w.restarts + 1;
        const delay = Math.min(1000 * 2 ** Math.min(w.restarts, 5), 30_000);
        w.timer = setTimeout(() => this.startWorker(w), delay);
        w.timer.unref();
      });
      proc.once('error', (err) => {
        this.log.error({ tenant: w.id, err: err.message }, 'worker failed to start');
        resolve();
      });
    });
  }

  private async waitForSocket(id: number): Promise<void> {
    const sock = this.socketPathFor(id);
    const deadline = Date.now() + this.cfg.workerReadyTimeoutMs;
    for (;;) {
      if (await probe(sock)) return;
      if (Date.now() > deadline) throw new Error('worker did not start in time');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async stopWorker(id: number): Promise<void> {
    const w = this.workers.get(id);
    if (!w) return;
    w.desired = false;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    const proc = w.proc;
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      const killer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
      await w.exited;
      clearTimeout(killer);
    }
    w.proc = null;
  }

  /** Deletes a tenant for good: worker, browser (profile included), data directory. Never the first account. */
  async removeTenant(id: number): Promise<void> {
    if (id === 1) throw new Error('the first account cannot be removed');
    await this.stopWorker(id);
    this.workers.delete(id);
    await this.deleteBrowser(id).catch((err: unknown) => {
      this.log.warn({ tenant: id, err: err instanceof Error ? err.message : String(err) }, 'could not remove the browser data');
    });
    for (const dir of [this.dataDirFor(id), this.socketDirFor(id)]) {
      await this.emptyAsTenant(id, dir);
      fs.rmdirSync(dir);
    }
  }

  /** Files inside a tenant directory belong to the tenant's user, and root has no DAC override: delete as that user. */
  private emptyAsTenant(id: number, dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(dir)) return resolve();
      const uid = this.uidFor(id);
      const p = spawn('find', [dir, '-mindepth', '1', '-delete'], {
        stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin' },
        ...(this.cfg.dropPrivileges ? { uid, gid: uid } : {}),
      });
      p.once('error', reject);
      p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`could not empty ${dir}`))));
    });
  }

  /** Stops the tenant's Chromium and deletes its profile (the WhatsApp session in it) in the chromium container. */
  async deleteBrowser(id: number): Promise<void> {
    const r = await fetch(`${this.cfg.chromiumUrl}/i/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken(this.cfg.controlSecret)}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`chromium manager answered ${r.status}`);
  }

  /* ----------------------------------------------------------- front */

  private startFront(): void {
    const f = this.front;
    f.desired = true;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
    for (const k of FRONT_ENV_PASSTHROUGH) if (this.cfg.env[k] !== undefined) env[k] = this.cfg.env[k];
    Object.assign(env, {
      FRONT_DATA_DIR: path.join(this.cfg.usersDir, 'system'),
      CONTROL_SOCKET: this.controlSocketPath(),
      CHROMIUM_URL: this.cfg.chromiumUrl,
    });
    const [cmd, ...args] = this.cfg.frontCommand;
    const proc = spawn(cmd!, args, {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: '/',
      ...(this.cfg.dropPrivileges ? { uid: this.cfg.frontUid, gid: this.cfg.frontUid } : {}),
    });
    f.proc = proc;
    const started = Date.now();
    this.log.info({ pid: proc.pid }, 'gateway started');
    proc.once('exit', (code, signal) => {
      if (f.proc !== proc) return;
      f.proc = null;
      this.log.warn({ code, signal }, 'gateway exited');
      if (!f.desired || this.shuttingDown) return;
      f.restarts = Date.now() - started > 60_000 ? 0 : f.restarts + 1;
      f.timer = setTimeout(() => this.startFront(), Math.min(1000 * 2 ** Math.min(f.restarts, 5), 30_000));
      f.timer.unref();
    });
  }

  /* -------------------------------------------------------- shutdown */

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info('shutting down');
    this.control?.close();
    // The gateway first (no new requests), then the workers (they flush their databases).
    this.front.desired = false;
    if (this.front.timer) clearTimeout(this.front.timer);
    const front = this.front.proc;
    if (front && front.exitCode === null) {
      const done = new Promise<void>((r) => front.once('exit', () => r()));
      front.kill('SIGTERM');
      await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))]);
      if (front.exitCode === null) front.kill('SIGKILL');
    }
    await Promise.all([...this.workers.keys()].map((id) => this.stopWorker(id)));
    fs.rmSync(this.controlSocketPath(), { force: true });
  }
}

function probe(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

export const TENANT_RANGE = { min: MIN_TENANT, max: MAX_TENANT };
