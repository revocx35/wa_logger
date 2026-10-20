import path from 'node:path';
import { z } from 'zod';

/**
 * EXTRA_PORTS: the ports the admin may assign to users besides the default PORT, as published by the reverse proxy
 * (docker-compose publishes the same range). "8101-8110", "8101,8105" and "8101-8103,8110" are all fine.
 */
export function parsePortList(spec: string | undefined): number[] {
  const out = new Set<number>();
  for (const part of (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) throw new Error(`EXTRA_PORTS: cannot parse "${part}"`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < 1 || hi > 65535 || hi < lo || hi - lo > 200) throw new Error(`EXTRA_PORTS: bad range "${part}"`);
    for (let p = lo; p <= hi; p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional().transform((v) => v ?? def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080, 1, 65535),
  FRONT_DATA_DIR: z.string().default('/users/system'),
  WEB_DIR: z.string().optional(),
  PUBLIC_ORIGIN: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined))
    .refine((v) => v === undefined || /^https?:\/\/[^/\s]+$/.test(v), 'PUBLIC_ORIGIN must look like https://host[:port]'),
  SETUP_TOKEN: z.string().min(16, 'SETUP_TOKEN must be at least 16 characters'),
  COOKIE_SECURE: z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'auto'])
    .optional()
    .transform((v): boolean | 'auto' => (v === undefined ? true : v === 'auto' ? 'auto' : v === 'true' || v === '1' || v === 'yes')),
  TRUST_PROXY: z
    .string()
    .regex(/^(true|false|yes|no|[0-5])$/)
    .optional()
    .transform((v) => (v === undefined || v === 'false' || v === 'no' ? 0 : v === 'true' || v === 'yes' ? 1 : Number(v))),
  SESSION_MAX_DAYS: int(7, 1, 90),
  EXTRA_PORTS: z.string().optional(),
  MAX_USERS: int(10, 1, 200),
  CONTROL_SOCKET: z.string().min(1).default('/run/wal/ctl/ctl.sock'),
  CHROMIUM_URL: z.string().default('http://chromium:9223'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SCRYPT_LOG_N: int(17, 10, 20),
});

export type FrontConfig = ReturnType<typeof loadFrontConfig>;

export function loadFrontConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.SCRYPT_LOG_N < 17) throw new Error('Invalid configuration:\n  - SCRYPT_LOG_N: must be >= 17 in production');
  const extraPorts = parsePortList(e.EXTRA_PORTS).filter((p) => p !== e.PORT);
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    dataDir: path.resolve(e.FRONT_DATA_DIR),
    dbPath: path.join(path.resolve(e.FRONT_DATA_DIR), 'system.db'),
    webDir: e.WEB_DIR ? path.resolve(e.WEB_DIR) : undefined,
    publicOrigin: e.PUBLIC_ORIGIN,
    setupToken: e.SETUP_TOKEN,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    sessionMaxMs: e.SESSION_MAX_DAYS * 86400_000,
    extraPorts,
    maxUsers: e.MAX_USERS,
    controlSocket: e.CONTROL_SOCKET,
    chromiumHost: new URL(e.CHROMIUM_URL).hostname,
    logLevel: e.LOG_LEVEL,
    scryptLogN: e.SCRYPT_LOG_N,
  };
}
