import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Migrations are append-only. Never edit a migration that has shipped; add a new one.
 * Columns suffixed `_enc` hold AES-256-GCM field blobs (see crypto/keyring.ts).
 */
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        pw_salt BLOB NOT NULL,
        pw_auth_hash BLOB NOT NULL,
        public_key BLOB NOT NULL,
        privkey_pw BLOB NOT NULL,
        privkey_recovery BLOB NOT NULL,
        recovery_salt BLOB NOT NULL,
        recovery_auth_hash BLOB NOT NULL,
        totp_secret_enc BLOB,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        totp_last_step INTEGER,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL,
        password_changed_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id_hash BLOB PRIMARY KEY,
        privkey_enc BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        ip TEXT,
        detail TEXT
      );
      CREATE INDEX audit_log_ts ON audit_log (ts);

      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE data_keys (
        id INTEGER PRIMARY KEY,
        eph_pub BLOB NOT NULL,
        wrapped BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE media (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        key_id INTEGER NOT NULL REFERENCES data_keys (id),
        mime_enc BLOB,
        filename_enc BLOB,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name_enc BLOB,
        last_ts INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        removed_at INTEGER,
        avatar_media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
        avatar_checked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX chats_last_ts ON chats (last_ts);

      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        name_enc BLOB,
        pushname_enc BLOB,
        is_me INTEGER NOT NULL DEFAULT 0,
        is_business INTEGER NOT NULL DEFAULT 0,
        avatar_media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
        avatar_checked_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT,
        from_me INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        body_enc BLOB,
        meta_enc BLOB,
        thumb_enc BLOB,
        quoted_id TEXT,
        media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
        media_status TEXT NOT NULL DEFAULT 'none',
        media_attempts INTEGER NOT NULL DEFAULT 0,
        media_size INTEGER,
        media_w INTEGER,
        media_h INTEGER,
        media_duration INTEGER,
        is_view_once INTEGER NOT NULL DEFAULT 0,
        is_forwarded INTEGER NOT NULL DEFAULT 0,
        is_status INTEGER NOT NULL DEFAULT 0,
        ack INTEGER,
        deleted_at INTEGER,
        deleted_by TEXT,
        deleted_for_me_at INTEGER,
        edited_at INTEGER,
        last_edit_key TEXT,
        source TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX messages_chat_ts ON messages (chat_id, ts);
      CREATE INDEX messages_deleted ON messages (deleted_at) WHERE deleted_at IS NOT NULL;
      CREATE INDEX messages_media_pending ON messages (media_status) WHERE media_status = 'pending';

      CREATE TABLE message_edits (
        id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL,
        body_enc BLOB,
        captured_at INTEGER NOT NULL
      );
      CREATE INDEX message_edits_msg ON message_edits (message_id);

      CREATE TABLE reactions (
        message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        emoji_enc BLOB,
        ts INTEGER NOT NULL,
        removed_at INTEGER,
        PRIMARY KEY (message_id, sender_id)
      );
    `,
  },
  {
    id: 2,
    name: 'contact_phone',
    // LID-addressed contacts ("…@lid") no longer carry the phone number in their id.
    sql: `ALTER TABLE contacts ADD COLUMN phone_enc BLOB;`,
  },
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  // Overwrite deleted content with zeros (matters for wipe / recovery-key rotation).
  db.pragma('secure_delete = ON');
  migrate(db);
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

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    })();
  }
}
