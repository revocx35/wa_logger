import net from 'node:net';
import type { ControlRequest, ControlResponse, WorkerHandle } from '../supervisor/protocol.js';

/** How the gateway reaches a tenant's worker, and asks for workers to be started, stopped and removed. */
export interface WorkerPool {
  /** Starts the tenant's worker if it is not running (idempotent) and returns how to talk to it. */
  ensure(tenant: number): Promise<WorkerHandle>;
  /** The handle if the worker was already started, without starting anything. */
  cached(tenant: number): WorkerHandle | undefined;
  stop(tenant: number): Promise<void>;
  /** Stops the worker and deletes its data and its browser profile. */
  remove(tenant: number): Promise<void>;
  /** Deletes the tenant's browser profile (the linked WhatsApp session) but keeps the worker. */
  resetBrowser(tenant: number): Promise<void>;
}

/** Talks to the supervisor over its unix socket (one JSON line per request and per response). */
export class SupervisorPool implements WorkerPool {
  private readonly handles = new Map<number, WorkerHandle>();
  private readonly inflight = new Map<number, Promise<WorkerHandle>>();
  private rid = 0;

  constructor(private readonly socketPath: string) {}

  cached(tenant: number): WorkerHandle | undefined {
    return this.handles.get(tenant);
  }

  ensure(tenant: number): Promise<WorkerHandle> {
    const known = this.handles.get(tenant);
    if (known) return Promise.resolve(known);
    let p = this.inflight.get(tenant);
    if (!p) {
      p = this.call({ op: 'spawn', tenant })
        .then((res) => {
          if (!res.ok || !res.socketPath || !res.internalToken) throw new Error('worker unavailable');
          const h: WorkerHandle = { socketPath: res.socketPath, internalToken: res.internalToken };
          this.handles.set(tenant, h);
          return h;
        })
        .finally(() => this.inflight.delete(tenant));
      this.inflight.set(tenant, p);
    }
    return p;
  }

  async stop(tenant: number): Promise<void> {
    this.handles.delete(tenant);
    this.must(await this.call({ op: 'stop', tenant }));
  }

  async remove(tenant: number): Promise<void> {
    this.handles.delete(tenant);
    this.must(await this.call({ op: 'remove', tenant }));
  }

  async resetBrowser(tenant: number): Promise<void> {
    this.must(await this.call({ op: 'reset-browser', tenant }));
  }

  /** Forget a handle after the worker stopped answering; the next ensure() asks the supervisor again. */
  forget(tenant: number): void {
    this.handles.delete(tenant);
  }

  private must(res: ControlResponse): void {
    if (!res.ok) throw new Error(res.error);
  }

  private call(req: Omit<ControlRequest, 'rid'>): Promise<ControlResponse> {
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const c = net.connect(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => {
        c.destroy();
        reject(new Error('supervisor timed out'));
      }, 90_000);
      c.setEncoding('utf8');
      c.on('connect', () => c.write(`${JSON.stringify({ ...req, rid })}\n`));
      c.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        c.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as ControlResponse);
        } catch {
          reject(new Error('bad answer from the supervisor'));
        }
      });
      c.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
