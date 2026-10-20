import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type UserRole = 'admin' | 'user';

export interface UserRow {
  id: number;
  username: string;
  role: UserRole;
  disabled: number;
  /** Listener port this user may sign in on; NULL = the default port. */
  port: number | null;
  created_at: number;
  last_login_at: number | null;
}

export interface ListenerRow {
  port: number;
  public_origin: string | null;
  created_at: number;
}

export interface FrontAuditRow {
  id: number;
  ts: number;
  event: string;
  actor: number | null;
  target: number | null;
  ip: string | null;
  detail: string | null;
}

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      -- AUTOINCREMENT: an id (and with it the user's unix user and data directory) is never reused.
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        disabled INTEGER NOT NULL DEFAULT 0,
        port INTEGER,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE TABLE listeners (
        port INTEGER PRIMARY KEY,
        public_origin TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        actor INTEGER,
        target INTEGER,
        ip TEXT,
        detail TEXT
      );
      CREATE INDEX audit_ts ON audit (ts);
    `,
  },
];

export function openSystemDb(file: string): Database.Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    })();
  }
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.chmodSync(f, 0o600);
      } catch {
        /* may not exist yet */
      }
    }
  }
  return db;
}

/** The gateway's own database: who the users are, which port each may use, what the admin did. No credentials, no data. */
export class SystemRepo {
  constructor(readonly db: Database.Database) {}

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  hasAdmin(): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
  }

  getUser(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
  }

  /** Returns the new id, or null when the name is taken. The admin is always id 1 (its data predates user management). */
  createUser(u: { id?: number; username: string; role: UserRole; port: number | null }, now = Date.now()): number | null {
    try {
      const r = u.id
        ? this.db.prepare('INSERT INTO users (id, username, role, port, created_at) VALUES (?, ?, ?, ?, ?)').run(u.id, u.username, u.role, u.port, now)
        : this.db.prepare('INSERT INTO users (username, role, port, created_at) VALUES (?, ?, ?, ?)').run(u.username, u.role, u.port, now);
      return Number(r.lastInsertRowid);
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return null;
      throw err;
    }
  }

  deleteUser(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  setPort(id: number, port: number | null): void {
    this.db.prepare('UPDATE users SET port = ? WHERE id = ?').run(port, id);
  }

  setDisabled(id: number, disabled: boolean): void {
    this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  }

  touchLogin(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
  }

  usersOnPort(port: number): UserRow[] {
    return this.db.prepare('SELECT * FROM users WHERE port = ? ORDER BY id').all(port) as UserRow[];
  }

  listListeners(): ListenerRow[] {
    return this.db.prepare('SELECT * FROM listeners ORDER BY port').all() as ListenerRow[];
  }

  getListener(port: number): ListenerRow | undefined {
    return this.db.prepare('SELECT * FROM listeners WHERE port = ?').get(port) as ListenerRow | undefined;
  }

  upsertListener(port: number, publicOrigin: string | null, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO listeners (port, public_origin, created_at) VALUES (?, ?, ?)
         ON CONFLICT (port) DO UPDATE SET public_origin = excluded.public_origin`,
      )
      .run(port, publicOrigin, now);
  }

  deleteListener(port: number): void {
    this.db.prepare('DELETE FROM listeners WHERE port = ?').run(port);
  }

  audit(event: string, ip: string | null, opts: { actor?: number | null; target?: number | null; detail?: string | null } = {}, ts = Date.now()): void {
    this.db
      .prepare('INSERT INTO audit (ts, event, actor, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, event, opts.actor ?? null, opts.target ?? null, ip, opts.detail ?? null);
  }

  listAudit(limit: number): FrontAuditRow[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as FrontAuditRow[];
  }
}
