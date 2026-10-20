import http from 'node:http';
import type { Logger } from '../log.js';

/**
 * The ports the gateway listens on: the default one (the admin's) plus the extra ones the admin opened for other
 * users. Every port is its own http.Server sharing one request handler; the port a request arrived on is what
 * decides who may sign in through it (see Gateway.policyOk).
 */
export class Listeners {
  private readonly servers = new Map<number, http.Server>();
  defaultPort = 0;

  constructor(
    private readonly host: string,
    private readonly allowed: readonly number[],
    private readonly log: Logger,
    private readonly make: () => http.Server,
  ) {}

  setDefault(port: number, server: http.Server): void {
    this.defaultPort = port;
    this.servers.set(port, server);
  }

  /** Ports the admin may open (what the reverse proxy / compose publishes). */
  allowedPorts(): readonly number[] {
    return this.allowed;
  }

  isAllowed(port: number): boolean {
    return this.allowed.includes(port);
  }

  isOpen(port: number): boolean {
    return this.servers.has(port);
  }

  open(port: number): Promise<void> {
    if (!this.isAllowed(port)) return Promise.reject(new Error('port not allowed'));
    if (this.servers.has(port)) return Promise.resolve();
    const server = this.make();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.host, port }, () => {
        server.off('error', reject);
        this.servers.set(port, server);
        this.log.info({ port }, 'extra port opened');
        resolve();
      });
    });
  }

  async close(port: number): Promise<void> {
    if (port === this.defaultPort) return;
    const server = this.servers.get(port);
    if (!server) return;
    this.servers.delete(port);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    this.log.info({ port }, 'extra port closed');
  }

  /** Drops every open connection of a port (a user was moved or disabled: long-lived streams must not outlive that). */
  dropConnections(port: number): void {
    this.servers.get(port)?.closeAllConnections();
  }

  async closeAll(): Promise<void> {
    for (const port of [...this.servers.keys()]) {
      const server = this.servers.get(port)!;
      if (port !== this.defaultPort) {
        this.servers.delete(port);
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
  }
}
