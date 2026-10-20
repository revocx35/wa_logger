import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type net from 'node:net';
import type { WorkerHandle } from '../supervisor/protocol.js';

/*
 * HTTP over the unix socket to a tenant's worker. The gateway is the only network-facing process, so it decides
 * what the worker sees about the client: it throws away every forwarding header the client sent and sets its own
 * (X-Forwarded-For = the address it worked out itself, -Proto, -Host) plus the worker's secret token.
 */

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const NOT_FORWARDED = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-server', 'forwarded', 'x-real-ip', 'via']);
/** Headers of our own that only the gateway may set (a client's are dropped). */
const isOurs = (k: string) => k.startsWith('x-wal-');

export interface ClientInfo {
  ip: string;
  proto: string;
  host: string;
}

export function upstreamHeaders(
  src: IncomingHttpHeaders,
  client: ClientInfo,
  handle: WorkerHandle,
  opts: { keepUpgrade?: boolean; internal?: boolean } = {},
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || NOT_FORWARDED.has(k) || isOurs(k)) continue;
    if (HOP_BY_HOP.has(k) && !(opts.keepUpgrade && (k === 'connection' || k === 'upgrade'))) continue;
    out[k] = v;
  }
  out['x-forwarded-for'] = client.ip;
  out['x-forwarded-proto'] = client.proto;
  out['x-forwarded-host'] = client.host;
  out['x-wal-internal'] = handle.internalToken;
  // Only the gateway's own calls may reach the worker's /internal routes; a request on behalf of a client never carries this.
  if (opts.internal) out['x-wal-scope'] = 'internal';
  return out;
}

export interface UpstreamResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const MAX_BUFFERED = 8 * 1024 * 1024;

/** A buffered request to the worker (small JSON in, small JSON out). */
export function callWorker(
  handle: WorkerHandle,
  o: { method: string; path: string; headers: http.OutgoingHttpHeaders; body?: string | Buffer; timeoutMs?: number },
): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? undefined : Buffer.from(o.body);
    const headers = { ...o.headers };
    delete headers['content-length'];
    if (body) headers['content-length'] = body.length;
    const req = http.request({ socketPath: handle.socketPath, method: o.method, path: o.path, headers, timeout: o.timeoutMs ?? 60_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BUFFERED) return req.destroy(new Error('response too large'));
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('worker timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Streams the client's request to the worker and the worker's response back (SSE, media, uploads). */
export function proxyStream(
  handle: WorkerHandle,
  req: IncomingMessage,
  res: ServerResponse,
  o: { headers: http.OutgoingHttpHeaders; rewriteHeaders?: (status: number, headers: IncomingHttpHeaders) => http.OutgoingHttpHeaders },
): void {
  const up = http.request({ socketPath: handle.socketPath, method: req.method, path: req.url, headers: o.headers }, (upRes) => {
    const headers: http.OutgoingHttpHeaders = {};
    const status = upRes.statusCode ?? 502;
    const rewritten = o.rewriteHeaders ? o.rewriteHeaders(status, upRes.headers) : (upRes.headers as http.OutgoingHttpHeaders);
    for (const [k, v] of Object.entries(rewritten)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    res.writeHead(status, upRes.statusMessage, headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":{"code":"unavailable","message":"The service is not reachable right now."}}');
    } else {
      res.destroy();
    }
  });
  // The client went away: stop the upstream request (a closed SSE stream must not keep the worker's handler alive).
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}

function writeHead(socket: net.Socket, status: number, message: string | undefined, rawHeaders: string[]): void {
  let head = `HTTP/1.1 ${status} ${message || http.STATUS_CODES[status] || ''}\r\n`;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const k = rawHeaders[i]!;
    if (/[\r\n]/.test(k) || /[\r\n]/.test(rawHeaders[i + 1]!)) continue;
    if (HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'connection' && k.toLowerCase() !== 'upgrade') continue;
    head += `${k}: ${rawHeaders[i + 1]}\r\n`;
  }
  socket.write(`${head}\r\n`);
}

/** Tunnels a WebSocket upgrade to the worker. */
export function proxyUpgrade(handle: WorkerHandle, req: IncomingMessage, socket: net.Socket, head: Buffer, headers: http.OutgoingHttpHeaders): void {
  const up = http.request({ socketPath: handle.socketPath, method: 'GET', path: req.url, headers });
  const fail = (status: number) => {
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    }
  };
  up.on('upgrade', (upRes, upSocket, upHead) => {
    writeHead(socket, 101, upRes.statusMessage, upRes.rawHeaders);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const end = () => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', end);
    upSocket.on('close', end);
    socket.on('error', end);
    socket.on('close', end);
  });
  up.on('response', (upRes) => {
    // The worker refused (not logged in, wrong origin…): hand the answer to the client as it is.
    writeHead(socket, upRes.statusCode ?? 502, upRes.statusMessage, upRes.rawHeaders);
    upRes.pipe(socket);
    upRes.on('end', () => socket.destroy());
  });
  up.on('error', () => fail(502));
  up.end();
}
