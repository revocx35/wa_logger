# wa_logger — Architecture

> Source of truth for design decisions. Read this (and `progress.md`) before changing anything.
> If you change a decision, update this file in the same commit.

## 1. What it is

A self-hosted, single-owner, Docker-based **WhatsApp message logger**. A real Chromium runs
WhatsApp Web in a background container. The app watches WhatsApp Web through the Chrome
DevTools Protocol (via `whatsapp-web.js`) and records **every message, edit, reaction and media file**
the owner's account sends or receives, encrypted at rest. When someone deletes a message
("deleted for everyone"), the logged copy stays viewable and is flagged as deleted.

The web UI is **read-only** (no sending). It looks like WhatsApp: chat list, chat view, media.
The live Chromium screen can be opened from the menu ("WA Web") through an in-browser VNC client.

Out of scope on purpose: sending messages, multiple WhatsApp accounts or tenants, and **view-once media**
(it is logged only as a placeholder and never downloaded).

## 2. User flow

1. **Signup** (`/signup`). Only possible while no owner account exists. It needs the
   `SETUP_TOKEN` from `.env`, so a stranger who reaches the page first cannot claim the instance.
   Fields: setup token, username, password (min 12 characters), confirm.
2. **Recovery key** (`/setup/recovery`). Shown once. It is the only way to recover the data if the
   password is lost (see §6). The user must tick "I saved it".
3. **Link WhatsApp** (`/setup/link`). Shows the live Chromium screen (noVNC) with WhatsApp Web's QR code
   and a status pill (`starting → qr → authenticating → syncing/ready`). The user scans the QR code with
   their phone. The **Complete** button is enabled once the WA state is `ready`.
   Clicking it marks onboarding done and forwards to `/`.
4. **Main** (`/`). A WhatsApp-like two-pane UI: chat list on the left, chat on the right, and a menu rail with
   **Chats**, **Deleted**, **WA Web**, **Settings** and **Logout**.
5. Later visits: go to `/login` (or `/signup` if no owner exists), then `/`
   (or `/setup/link` if onboarding is not complete).

## 3. Containers & networks

```
                internet
                   │
          ┌────────┴────────┐   network: public (bridge)      ports 80/443 published
          │      caddy      │   TLS termination (ACME or internal CA), HTTP→HTTPS
          └────────┬────────┘
                   │ network: edge (internal: true)
          ┌────────┴────────┐
          │       app       │   Node 24 · Fastify · whatsapp-web.js · SQLite · serves built web UI
          │  (no internet)  │   volume app_data:/data  (db + encrypted media)
          └────────┬────────┘
                   │ network: backend (internal: true)
                   │   tcp 9223 → CDP (socat → 127.0.0.1:9222)   tcp 5900 → x11vnc
          ┌────────┴────────┐
          │    chromium     │   Debian trixie · Chromium (headful, sandbox ON via seccomp profile)
          │                 │   Xvfb :99 · x11vnc · socat · volume chromium_profile:/data
          └────────┬────────┘
                   │ network: egress (bridge) → web.whatsapp.com / WA CDNs
                internet
```

* Only **caddy** publishes ports. The **app** has no route to the internet (it sits only on internal networks).
  **chromium** is the only component that talks to WhatsApp.
* CDP has no authentication, so it is reachable only on `backend`, where the app is the only other container.
  Chromium ignores `--remote-debugging-address` in headful mode, so it listens on 127.0.0.1:9222 and
  `socat` exposes it as `0.0.0.0:9223` inside the container.
* Chrome rejects CDP HTTP requests whose `Host` header is not an IP or `localhost`. The app therefore
  **resolves `CHROMIUM_HOST` to an IP** (`dns.lookup`) and connects to `http://<ip>:9223`.
* x11vnc is protected by `VNC_PASSWORD` (defense in depth). Its port is reachable only on `backend`, and the
  browser reaches it **only** through the app's authenticated WebSocket bridge `/api/vnc`.
* Hardening on every container: `no-new-privileges`, `cap_drop: [ALL]` (caddy re-adds `NET_BIND_SERVICE`),
  non-root users, `read_only` root filesystems with explicit tmpfs mounts, memory limits, healthchecks.
* Chromium keeps its **sandbox enabled**. Docker's default seccomp profile blocks the user-namespace syscalls
  the sandbox needs, so `chromium/seccomp-chromium.json` (Docker's default profile plus `clone`, `clone3`,
  `unshare`, `setns`, `chroot` and similar) is applied. **Never ship `--no-sandbox`.** It is available only as an
  explicit escape hatch (`CHROMIUM_NO_SANDBOX=1`) with a startup warning.

### chromium container
* `entrypoint.sh` acts as a small supervisor (bash `wait -n` plus restart loops). It removes stale
  `Singleton*` locks, then starts `Xvfb :99 -screen 0 ${SCREEN}`,
  `chromium --user-data-dir=/data/profile --remote-debugging-port=9222 --kiosk --no-first-run
  --no-default-browser-check --password-store=basic --disable-features=Translate,MediaRouter
  --noerrdialogs --hide-crash-restore-bubble --window-position=0,0 --window-size=W,H about:blank`,
  `x11vnc -display :99 -rfbport 5900 -rfbauth … -forever -shared`, and
  `socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222`. Crashed children are restarted.
* The healthcheck calls `curl -fs http://127.0.0.1:9222/json/version`.
* The profile volume **contains the live WhatsApp session**. Anyone with it can impersonate the account.

## 4. App (server) — `server/`

Node 24 LTS, TypeScript (ESM), Fastify 5, better-sqlite3 (WAL), zod for validation, and whatsapp-web.js
(pinned; puppeteer download skipped). Tests use vitest.

```
server/src/
  index.ts            bootstrap: config → db → crypto keyring → http → wa (only once an owner exists)
  config.ts           zod-parsed env (see §9); fails fast on bad config
  log.ts              pino with redaction (cookies, auth headers, passwords, tokens, message bodies)
  db/                 connection, migrations (schema in §7), repositories (typed, prepared statements)
  crypto/
    primitives.ts     AES-256-GCM, HKDF-SHA256, X25519 ECDH, scrypt, random, constant-time compare
    password.ts       scrypt-derived auth hash + KEK (§6)
    keyring.ts        owner keypair, DEK (data-encryption key) lifecycle, unwrap cache
    field.ts          encrypt/decrypt DB fields with AAD binding
    stream.ts         chunked AEAD file format for media, range-decrypt
  auth/               signup, login, logout, recovery, sessions, TOTP, CSRF, rate limits, audit
  http/               server factory, security headers/CSP, static web UI, error handler
  api/                chats, messages, media (Range), search, deleted feed, SSE events, settings, audit, data wipe
  vnc/                authenticated WebSocket ↔ TCP bridge to chromium:5900
  wa/
    browser.ts        resolve host → IP, connect puppeteer to CDP, tab hygiene (close stale WA tabs)
    client.ts         whatsapp-web.js Client lifecycle, state machine, reconnect with backoff
    ingest.ts         event handlers → mapper → repositories (idempotent upserts)
    mapper.ts         whatsapp-web.js Message/Chat/Contact → DB records (pure, unit-tested)
    media.ts          priority download queue (live > history), size cap, retries, encryption to disk
    sync.ts           initial history import + periodic reconcile (catches missed/revoked msgs)
    avatars.ts        best-effort profile pictures (fetched inside the browser page, never by the app)
shared/api.d.ts       API DTO types shared by server and web (type-only)
```

### WhatsApp integration rules
* Create the `Client` with `puppeteer: { browserURL: 'http://<ip>:9223', defaultViewport: null }`,
  `authStrategy: NoAuth` (the session lives in the Chromium profile volume),
  `webVersionCache: { type: 'none' }` (the container filesystem is read-only), and `takeoverOnConflict: true`.
* **Never call `client.destroy()`.** On a connected browser it would close the remote Chromium. On shutdown,
  `browser.disconnect()`. Before initialize, close leftover `web.whatsapp.com` tabs. After initialize,
  close stray `about:blank` tabs and `bringToFront()` the WA tab, so VNC shows it and there is only one WA tab.
* Start the WA client only once an owner exists, because the owner's public key is required to encrypt anything.
* Events used: `qr`, `loading_screen`, `authenticated`, `auth_failure`, `ready`, `change_state`,
  `disconnected`, `message_create` (fires for incoming **and** outgoing messages, so it is the single source for new
  messages), `message_ciphertext`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`,
  `message_reaction`, `message_ack`, `chat_removed`, `chat_archived`, `group_join`, `group_leave`,
  `group_update`, `contact_changed`. All handlers are idempotent upserts keyed by the serialized message ID.
* **Media is downloaded immediately** on `message_create`, because after a revoke it can no longer be
  fetched. The queue runs at concurrency 2 with 3 retries and exponential backoff. Media larger than
  `MEDIA_MAX_MB` is marked `too_large`, not downloaded. Failed or too-large media can be retried from the UI
  while it is still available.
* **View-once** (`isViewOnce` or a view-once wrapper type) → stored with `media_status='view_once'`. No download,
  no thumbnail. The UI shows a "View-once media is not logged" placeholder.
* Revoke: `message_revoke_everyone(after, before)` → mark the original row `deleted_at=now`, `deleted_by`.
  If the original was never logged and `before` is present, insert it first.
  If both are missing, insert a stub row flagged deleted with `body=null`.
* Edit: `message_edit(msg, newBody, prevBody)` → push `prevBody` into `message_edits` (dedupe), set
  `body=newBody` and `edited_at`.
* History: after the first `ready`, fetch each chat's last `HISTORY_PER_CHAT` messages (default 200) and upsert
  them with `source='history'`. History media is queued at low priority, depending on the setting.
* Reconcile every `RECONCILE_MINUTES` (default 10) and on every `ready`: re-fetch recent messages of chats
  whose `timestamp` moved, upsert them, and mark as deleted any message whose type has become `revoked`.
  This catches events missed while the app was down.
* Status updates (`status@broadcast`) are logged when setting `log_status=true` (default) and appear as a
  special "Status updates" chat.

## 5. Web UI — `web/`

React 19 + Vite + TypeScript SPA, built into `server` static assets. No CDN, no external fonts, and no inline
scripts, so it satisfies a strict CSP. `@novnc/novnc` provides the VNC client, and `qrcode` renders the TOTP enrollment QR code.

Routes: `/signup`, `/login`, `/recover`, `/setup/recovery`, `/setup/link`, `/` (chats), `/chat/:chatId`,
`/deleted`, `/wa-web`, `/settings`. A route guard uses `GET /api/state` to decide where the user belongs.

Chat view features: date separators; sender names (colored) in groups; the WA text formatting parser
(`*bold*`, `_italic_`, `~strike~`, `` ```mono``` ``, `> quote`, lists, links) renders to React elements, **never HTML**;
quoted replies (click to jump); forwarded label; edited badge with an edit-history popover;
deleted badge (red, "Deleted for everyone · logged copy") while still showing the content; reactions; ticks for
own messages; image lightbox; `<video>`/`<audio>` players (Range-served); documents download as attachments;
stickers; location cards (coordinates plus an OpenStreetMap link, no embedded map); vCards; polls; call logs and
system messages as centered pills; a view-once placeholder; infinite scroll upward; live updates via SSE;
per-chat and global search. Layout is responsive (single pane under 900px). Light and dark themes follow the system.

## 6. Security model

**Threats considered:** internet attackers reaching the login page, CSRF/XSS against the owner's browser,
malicious message content (HTML/SVG/scripts inside messages or media), theft of disk or backups,
lateral movement between containers, brute force.

**Accepted / out of scope:** a fully compromised running host (it can read process memory and the live WA
session), and WhatsApp's own terms of service (unofficial client; ban risk is the user's decision).

### Authentication
* Single owner. Signup is closed permanently once an owner exists and requires `SETUP_TOKEN`
  (constant-time compare, rate limited).
* Password: min 12 characters, max 256, rejected if it matches the username or a small common-password list.
  `master = scrypt(pw, salt32, N=2^17, r=8, p=1, 32B)`, `authHash = HKDF(master, "wal/v1/auth")` (stored),
  `KEK = HKDF(master, "wal/v1/kek")` (never stored).
* Optional TOTP (RFC 6238, SHA-1, 6 digits, ±1 step, replay-protected by storing the last used step). The secret is
  encrypted with a key derived from the KEK, so it is only readable after a correct password.
* Recovery key: 32 random bytes shown once as Base32 groups. It wraps a second copy of the private key
  (`HKDF(scrypt(recoveryKey, salt), "wal/v1/recovery-kek")`). Recovery = recovery key + new password.
  It disables TOTP and rotates the recovery key.
* Brute force: per-IP rate limits on auth routes (`@fastify/rate-limit`) plus a per-account failure counter
  in the DB with progressive delay/lockout (survives restarts). All auth events go to `audit_log`.

### Sessions
* Cookie `__Host-wal_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`). Value is
  `b64url(sid32).b64url(secret32)`. The DB stores `sha256(sid)` and the owner private key encrypted under
  `HKDF(secret, "wal/v1/session")`. **A DB dump without a live cookie cannot decrypt anything.**
* Idle timeout `SESSION_IDLE_HOURS` (default 8) and absolute `SESSION_MAX_DAYS` (default 7). Sessions can be listed and revoked, including "log out everywhere".
  A password change revokes all other sessions.
* `COOKIE_SECURE=false` (dev/HTTP only) drops the `__Host-` prefix and `Secure`, and logs a loud warning.

### CSRF / request integrity
* Every non-GET `/api` request must have `Content-Type: application/json` and an `Origin` that matches `PUBLIC_ORIGIN`
  (or the request `Host` when that is unset). Authenticated non-GET requests must also carry
  `X-CSRF-Token = HMAC(HKDF(secret,"wal/v1/csrf"), "csrf")`, which `GET /api/state` returns.
* The WebSocket (`/api/vnc`) and SSE (`/api/events`) require a valid session cookie and a matching `Origin`.

### Encryption at rest (envelope, public-key)
The logger writes while the owner is logged out, but must not be able to read old data without the owner.
* At signup: an X25519 keypair. The public key is stored in plaintext. The private key (PKCS8) is AES-256-GCM encrypted under the
  password KEK and, as a second copy, under the recovery KEK.
* **DEK (data key):** random 32 bytes, created at each process start and rotated every 24h. It is wrapped with ECIES
  to the owner's public key (ephemeral X25519 → ECDH → `HKDF(shared, salt=ephPub‖ownerPub, "wal/v1/dek")` →
  AES-256-GCM) and stored in `data_keys`. Only the current DEK is kept in memory for writing.
* **Fields:** `0x01 ‖ keyId(u32be) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, AES-256-GCM with
  AAD = `"wal/v1|<table>|<column>|<rowId>"` (this stops ciphertexts from being swapped between rows or columns).
* **Media files:** header `"WAL1" ‖ version ‖ keyId(u32be) ‖ noncePrefix(8)`, then 64 KiB plaintext chunks, each
  AES-256-GCM with nonce = `prefix ‖ u32be(chunkIndex)` and AAD = `"wal/v1|media|<mediaId>|<chunkIndex>|<final?>"`.
  This enables HTTP Range requests (decrypt only the needed chunks) and detects truncation or reordering.
  Files are stored as `/data/media/<2 hex>/<uuid>.bin` (random names, no plaintext hashes).
* **Reading:** a session request unlocks the private key (with the session secret from the cookie) and unwraps the needed
  DEKs. Unwrapped DEKs and private keys are cached in memory for at most 10 minutes and cleared on logout,
  password change and wipe.
* **Encrypted:** message bodies and captions, `meta` JSON (quoted snapshot, location, vCard, poll, mentions, links),
  thumbnails, edit history, reaction emoji, chat names, contact names, pushnames, and all media (including avatars)
  with their mime type and filename.
* **Plaintext (metadata):** WA IDs (these contain phone numbers), timestamps, message types, flags (deleted/edited/fromMe/
  forwarded), acks, and media sizes/dimensions. Documented. Host full-disk encryption is recommended.
* A password change re-wraps only the private key (cheap). A lost password plus a lost recovery key means **the data is gone by design**.

### HTTP hardening
* CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:;
  connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
* HSTS (when secure), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`
  (all powerful features disabled), `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` on `/api/*`.
* Media responses: a fixed allowlist of inline-safe MIME types (raster images excluding SVG, audio/*, video/*).
  Everything else is served as `application/octet-stream` with `Content-Disposition: attachment` and a
  `Content-Security-Policy: sandbox; default-src 'none'` response header. Filenames are sanitized.
* Message text is never rendered as HTML. Links get `rel="noopener noreferrer nofollow"` and `target=_blank`.
  No link previews are fetched.
* zod validates every body, query and params. Errors are generic, and internal details are logged with a
  request ID and never returned to the client.
* Logs never contain message content, names, cookies or secrets (pino `redact` plus a code discipline enforced by review).

## 7. Database (SQLite, `/data/wa_logger.db`, WAL, `foreign_keys=ON`)

```sql
owner(id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, pw_salt BLOB, pw_auth_hash BLOB,
      public_key BLOB, privkey_pw BLOB, privkey_recovery BLOB, recovery_salt BLOB, recovery_auth_hash BLOB,
      totp_secret_enc BLOB, totp_enabled INTEGER DEFAULT 0, totp_last_step INTEGER,
      failed_logins INTEGER DEFAULT 0, locked_until INTEGER, created_at INTEGER, password_changed_at INTEGER)
sessions(id_hash BLOB PRIMARY KEY, privkey_enc BLOB, created_at, last_seen_at, expires_at, ip TEXT, user_agent TEXT)
audit_log(id INTEGER PRIMARY KEY, ts INTEGER, event TEXT, ip TEXT, detail TEXT)          -- no message content
app_state(key TEXT PRIMARY KEY, value TEXT)                                              -- onboarding_complete, settings JSON…
data_keys(id INTEGER PRIMARY KEY, eph_pub BLOB, nonce BLOB, wrapped BLOB, created_at INTEGER)
chats(id TEXT PRIMARY KEY, kind TEXT, name_enc BLOB, last_ts INTEGER, last_message_id TEXT, archived INTEGER,
      pinned INTEGER, muted INTEGER, removed_at INTEGER, avatar_media_id INTEGER, created_at, updated_at)
contacts(id TEXT PRIMARY KEY, name_enc BLOB, pushname_enc BLOB, is_me INTEGER, is_business INTEGER,
         avatar_media_id INTEGER, updated_at)
messages(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT, from_me INTEGER, ts INTEGER, type TEXT,
         body_enc BLOB, meta_enc BLOB, thumb_enc BLOB, quoted_id TEXT,
         media_id INTEGER, media_status TEXT, media_size INTEGER, media_w INTEGER, media_h INTEGER, media_duration INTEGER,
         is_view_once INTEGER, is_forwarded INTEGER, is_status INTEGER, ack INTEGER,
         deleted_at INTEGER, deleted_by TEXT, deleted_for_me_at INTEGER, edited_at INTEGER,
         source TEXT, captured_at INTEGER, updated_at INTEGER)
  INDEX messages(chat_id, ts), INDEX messages(deleted_at) WHERE deleted_at IS NOT NULL
message_edits(id INTEGER PRIMARY KEY, message_id TEXT, body_enc BLOB, captured_at INTEGER)
reactions(message_id TEXT, sender_id TEXT, emoji_enc BLOB, ts INTEGER, removed_at INTEGER, PRIMARY KEY(message_id, sender_id))
media(id INTEGER PRIMARY KEY, path TEXT, key_id INTEGER, mime_enc BLOB, filename_enc BLOB, size INTEGER, created_at INTEGER)
```
Migrations are numbered SQL files applied in a transaction and tracked in `schema_migrations`.

## 8. HTTP API (JSON; DTO types in `shared/api.d.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/state | – | `{hasOwner, authenticated, onboardingComplete, csrfToken?, wa?}` |
| POST | /api/auth/signup | setup token | create owner → `{recoveryKey}` + session |
| POST | /api/auth/login | – | `{username,password,totp?}` → session (`{needTotp:true}` if missing) |
| POST | /api/auth/logout · /api/auth/logout-all | ✓ | |
| POST | /api/auth/recover | – | `{username, recoveryKey, newPassword}` → `{recoveryKey}` (new) |
| POST | /api/auth/password | ✓ | `{currentPassword,newPassword}` |
| GET/DELETE | /api/auth/sessions[/:id] | ✓ | list / revoke |
| POST | /api/auth/totp/setup · enable · disable | ✓ | TOTP enrollment |
| POST | /api/auth/recovery-key/rotate | ✓ | `{password}` → new recovery key |
| GET | /api/wa/status | ✓ | `WaStatus` |
| POST | /api/wa/restart · /api/wa/logout | ✓ | reconnect / unlink device |
| POST | /api/onboarding/complete | ✓ | requires WA `ready` |
| GET | /api/vnc/credentials | ✓ | `{password}` for noVNC |
| WS | /api/vnc | ✓ | binary bridge to chromium:5900 |
| GET | /api/chats | ✓ | `ChatSummary[]` (sorted pinned, last_ts desc) |
| GET | /api/chats/:chatId/messages?before=&limit= | ✓ | `MessagePage` (newest-first pages) |
| GET | /api/chats/:chatId/messages/around/:messageId | ✓ | page centered on a message (jump to quote/search hit) |
| GET | /api/messages/:messageId/edits | ✓ | edit history |
| GET | /api/media/:mediaId | ✓ | decrypted stream, Range supported |
| POST | /api/messages/:messageId/media/retry | ✓ | re-queue download |
| GET | /api/deleted?before= | ✓ | feed of deleted messages across chats |
| GET | /api/search?q=&chatId= | ✓ | decrypt-and-scan search (bounded) |
| GET | /api/events | ✓ | SSE: `wa_state`, `message`, `message_update`, `chat_update`, `sync_progress` |
| GET/PUT | /api/settings | ✓ | `{logStatus, downloadHistoryMedia, mediaMaxMb, historyPerChat}` |
| GET | /api/audit | ✓ | audit log |
| POST | /api/data/wipe | ✓ + password | delete all logged messages/media (keeps owner) |

## 9. Configuration (`.env`, generated by `scripts/setup.sh`)

`SITE_ADDRESS` (e.g. `wa.example.com` or `192.168.1.50`), `CADDY_TLS` (`internal` or an ACME email),
`PUBLIC_ORIGIN` (e.g. `https://wa.example.com`), `SETUP_TOKEN`, `VNC_PASSWORD`, `COOKIE_SECURE` (default true),
`SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`, `MEDIA_MAX_MB` (default 100), `HISTORY_PER_CHAT` (200),
`RECONCILE_MINUTES` (10), `CHROMIUM_HOST` (`chromium`), `CDP_PORT` (9223), `VNC_PORT` (5900),
`SCREEN` (`1280x800x24`), `LOG_LEVEL` (info), `TRUST_PROXY` (true behind caddy).

## 10. Testing

* `server`: vitest. Covers crypto round-trips and tamper/AAD-mismatch failures, chunked range decrypt, auth flows through
  `fastify.inject` (signup gating, login, lockout, CSRF/Origin, session expiry, recovery), a route-table test
  asserting that every `/api` route except the public allowlist rejects anonymous requests, mapper fixtures for
  every message type, and revoke/edit/reaction ingest.
* `web`: vitest for the formatting parser (including injection attempts), `tsc --noEmit`, and a production build.
* `scripts/smoke.sh`: `docker compose up`, then signup through the API, wait for WA state `qr`, check that the VNC
  bridge answers `RFB 003.00x`, check security headers, then tear down.
