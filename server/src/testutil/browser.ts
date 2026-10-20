import http from 'node:http';

export interface BrowserRes {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

/** A browser: one cookie jar, talks to a gateway port, sends the same-origin Origin header. */
export class Browser {
  jar = new Map<string, string>();
  csrf = '';

  constructor(public port: number) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  req(method: string, urlPath: string, body?: unknown, o: { origin?: string | null; headers?: Record<string, string>; port?: number; csrf?: boolean } = {}): Promise<BrowserRes> {
    const port = o.port ?? this.port;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.origin !== null) headers.origin = o.origin ?? `http://127.0.0.1:${port}`;
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (this.csrf && o.csrf !== false) headers['x-csrf-token'] = this.csrf;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
            const [pair] = c.split(';');
            const i = (pair ?? '').indexOf('=');
            const name = (pair ?? '').slice(0, i);
            const value = (pair ?? '').slice(i + 1);
            if (!name) continue;
            if (!value || /Max-Age=0/i.test(c)) this.jar.delete(name);
            else this.jar.set(name, value);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      });
      r.on('error', reject);
      r.end(payload);
    });
  }

  async state(o: { port?: number } = {}): Promise<any> {
    const r = await this.req('GET', '/api/state', undefined, o);
    this.csrf = r.body?.csrfToken ?? '';
    return r.body;
  }
}
