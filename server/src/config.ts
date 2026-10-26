import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional().transform((v) => v ?? def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080, 1, 65535),
  DATA_DIR: z.string().default('/data'),
  WEB_DIR: z.string().optional(),
  /** Full origin the browser uses, e.g. https://wa.example.com — used for Origin checks. */
  PUBLIC_ORIGIN: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined))
    .refine((v) => v === undefined || /^https?:\/\/[^/\s]+$/.test(v), 'PUBLIC_ORIGIN must look like https://host[:port]'),
  /** Single-process mode only (tests, development): enables POST /api/auth/signup. The gateway checks the setup token
   *  itself and creates the admin through /internal/signup, so tenant workers run without it. */
  SETUP_TOKEN: z.string().min(16, 'SETUP_TOKEN must be at least 16 characters').optional(),
  /** Tenant worker: listen on this unix socket instead of HOST:PORT (the directory permissions decide who may connect). */
  SOCKET_PATH: z.string().min(1).optional(),
  /** Tenant worker: shared secret of the gateway. When set, every request must carry it (X-WAL-Internal) and the
   *  /internal/* routes exist. */
  INTERNAL_TOKEN: z.string().min(32).optional(),
  /** Base URL of the chromium container's manager (it hosts one Chromium per user). */
  CHROMIUM_URL: z
    .string()
    .default('http://chromium:9223')
    .refine((v) => /^https?:\/\/[^/\s]+$/.test(v), 'CHROMIUM_URL must look like http://host:port'),
  /** Which Chromium instance of the manager belongs to this tenant, and the bearer token that proves it. */
  CHROMIUM_INSTANCE: int(1, 1, 1_000_000),
  /** Which user this worker serves (the supervisor sets it; 1 in single-process mode). Goes into API tokens so the gateway can route them. */
  TENANT_ID: int(1, 1, 9999),
  CHROMIUM_TOKEN: z.string().min(16).optional(),
  /** true: always Secure/__Host- cookies; auto: Secure only when the request arrived over HTTPS (TLS by an
   *  external reverse proxy, detected via the trusted X-Forwarded-Proto); false: never (local HTTP only). */
  COOKIE_SECURE: z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'auto'])
    .optional()
    .transform((v): boolean | 'auto' => (v === undefined ? true : v === 'auto' ? 'auto' : v === 'true' || v === '1' || v === 'yes')),
  /** Number of reverse-proxy hops to trust for X-Forwarded-*: false/0 = none, true = 1 (the bundled Caddy),
   *  2 = Caddy + one external reverse proxy in front of it. */
  TRUST_PROXY: z
    .string()
    .regex(/^(true|false|yes|no|[0-5])$/)
    .optional()
    .transform((v) => (v === undefined || v === 'false' || v === 'no' ? 0 : v === 'true' || v === 'yes' ? 1 : Number(v))),
  SESSION_IDLE_HOURS: int(8, 1, 24 * 30),
  SESSION_MAX_DAYS: int(7, 1, 90),
  MEDIA_MAX_MB: int(100, 1, 2000),
  HISTORY_PER_CHAT: int(200, 0, 5000),
  RECONCILE_MINUTES: int(10, 1, 24 * 60),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Disable the WhatsApp client entirely (tests / API-only development). */
  WA_ENABLED: bool(true),
  /** scrypt cost exponent (N = 2^SCRYPT_LOG_N). Lower values are only allowed outside production. */
  SCRYPT_LOG_N: int(17, 10, 20),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.SCRYPT_LOG_N < 17) {
    throw new Error('Invalid configuration:\n  - SCRYPT_LOG_N: must be >= 17 in production');
  }
  const dataDir = path.resolve(e.DATA_DIR);
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    dataDir,
    dbPath: path.join(dataDir, 'wa_logger.db'),
    mediaDir: path.join(dataDir, 'media'),
    webDir: e.WEB_DIR ? path.resolve(e.WEB_DIR) : undefined,
    publicOrigin: e.PUBLIC_ORIGIN,
    setupToken: e.SETUP_TOKEN,
    socketPath: e.SOCKET_PATH,
    internalToken: e.INTERNAL_TOKEN,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    sessionIdleMs: e.SESSION_IDLE_HOURS * 3600_000,
    sessionMaxMs: e.SESSION_MAX_DAYS * 86400_000,
    defaults: {
      mediaMaxMb: e.MEDIA_MAX_MB,
      historyPerChat: e.HISTORY_PER_CHAT,
    },
    reconcileMs: e.RECONCILE_MINUTES * 60_000,
    chromiumUrl: e.CHROMIUM_URL,
    chromiumHost: new URL(e.CHROMIUM_URL).hostname,
    chromiumInstance: e.CHROMIUM_INSTANCE,
    tenantId: e.TENANT_ID,
    chromiumToken: e.CHROMIUM_TOKEN,
    logLevel: e.LOG_LEVEL,
    waEnabled: e.WA_ENABLED,
    scryptLogN: e.SCRYPT_LOG_N,
  };
}
