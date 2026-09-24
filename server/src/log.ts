import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Logging policy: never log message content, contact/chat names, cookies, tokens, passwords or keys.
 * Request URLs are logged without query strings, and long digit runs (phone numbers inside WhatsApp
 * IDs) are masked.
 */

export function maskUrl(url: string | undefined): string {
  if (!url) return '';
  const noQuery = url.split('?')[0] ?? '';
  return noQuery.replace(/\d{5,}/g, (m) => `${m.slice(0, 2)}…${m.slice(-2)}`);
}

export function maskId(id: string | null | undefined): string {
  if (!id) return String(id);
  return id.replace(/\d{5,}/g, (m) => `${m.slice(0, 2)}…${m.slice(-2)}`);
}

const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.setupToken',
  '*.recoveryKey',
  '*.totp',
  '*.code',
  '*.secret',
  '*.body',
  '*.text',
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req(req: { method?: string; url?: string; id?: string }) {
        return { id: req.id, method: req.method, url: maskUrl(req.url) };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
      err: pino.stdSerializers.err,
    },
  };
}

export function createLogger(level: string): Logger {
  return pino(loggerOptions(level));
}

export type { Logger };
