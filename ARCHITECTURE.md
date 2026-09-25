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

* Two compose files: `docker-compose.yml` builds all three images from source (`Dockerfile`, `chromium/`, `caddy/`),
  and `deploy/docker-compose.yml` uses the images CI publishes to GHCR (`ghcr.io/revocx35/wa_logger-{app,chromium,caddy}`).
  The standalone variant only needs `seccomp-chromium.json` and `.env` next to it. The Caddyfile is baked into the
  caddy image so Caddy keeps a read-only root filesystem (compose `configs.content` cannot be used with `read_only`).
* HTTP mode (`CADDY_CONFIG=Caddyfile.http`, `setup.sh --http-only`): Caddy serves plain HTTP behind the user's own
  TLS reverse proxy and trusts X-Forwarded-* from private ranges. The app uses `TRUST_PROXY=2` and
  `COOKIE_SECURE=auto`: `Secure`/`__Host-` cookies and HSTS whenever the request arrived over HTTPS.
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
    keyring.ts        owner keypair, DEK lifecycle, ECIES seal, field encryption with AAD binding, DataReader/Writer
    stream.ts         chunked AEAD file format for media, range-decrypt
  auth/               routes (signup, login, logout, recovery, TOTP, password), sessions (cookie, CSRF token),
                      throttle.ts (race-free per-IP + global brute-force throttle), totp.ts
  http/               server factory, security headers/CSP, static web UI, error handler
  api/                chats, messages, media (Range), search, deleted feed, SSE events, settings, audit, data wipe
  vnc/                authenticated WebSocket ↔ TCP bridge to chromium:5900
  wa/
    pageapi.ts        direct reads from WhatsApp Web's models: chats, contacts (LID → phone), history, avatars
    browser.ts        resolve host → IP, connect puppeteer to CDP, tab hygiene (close stale WA tabs)
    client.ts         whatsapp-web.js Client lifecycle, state machine, reconnect with backoff
    ingest.ts         event handlers → mapper → repositories (idempotent upserts)
    mapper.ts         serialized WA message → DB record (pure, unit-tested); msgKey() rebuilds message keys
    media.ts          priority download queue (live > history), size cap, timeouts, retries, disk guard, encryption
    sync.ts           initial history import + periodic reconcile (catches missed/revoked msgs)
    avatars.ts        best-effort profile pictures (fetched inside the browser page, never by the app)
  testutil/           harness (in-process app + cookie-jar client), seed.ts (dev sample data) — not in the build
shared/api.d.ts       API DTO types shared by server and web (type-only)
```

### WhatsApp integration rules
* Create the `Client` with `puppeteer: { browserURL: 'http://<ip>:9223', defaultViewport: null }`,
  `authStrategy: NoAuth` (the session lives in the Chromium profile volume),
  `webVersionCache: { type: 'none' }` (the container filesystem is read-only), and `takeoverOnConflict: true`.
* **Never call `client.destroy()`.** On a connected browser it would close the remote Chromium. On shutdown,
  `browser.disconnect()`. Before initialize, close leftover `web.whatsapp.com` tabs. After initialize,
  close stray `about:blank` tabs and `bringToFront()` the WA tab, so VNC shows it and there is only one WA tab.
* A crashed or closed WhatsApp tab (`page` `error`/`close`), a lost CDP connection, or a page that stops answering
  a 60 s watchdog probe twice triggers a reconnect with backoff. Reconcile then catches up on missed messages.
* **Do not use whatsapp-web.js chat helpers** (`getChats`, `getChatById`, `getProfilePicUrl`, `Chat.fetchMessages`):
  on current WhatsApp Web builds they go through `WWebJS.getChatModel`, which throws for ~90% of chats (and
  `getChats` fails as a whole). `wa/pageapi.ts` reads the same data directly from WhatsApp Web's models with
  per-chat error isolation. Events and `WWebJS.getMessageModel` (message serialization) are still used.
* **Message keys:** WhatsApp Web's MsgKey no longer serializes `_serialized`. `mapper.ts#msgKey()` rebuilds
  `<fromMe>_<remote>_<id>[_<participant>][_<self>]` (own messages end in `_out`), identical to
  `MsgKey.toString()`. Messages without a buildable key are skipped. Everything (media lookups via `Msg.get`,
  quotes, reactions, revokes) depends on this key being right.
* **LID ids:** one-to-one chats and group participants use `…@lid` ids (no phone number). The phone number
  comes from `contact.phoneNumber` or `WAWebLidMigrationUtils.toPn()` and is stored encrypted (`contacts.phone_enc`)
  as the last name fallback (saved name → `~pushname` → phone).
* Start the WA client only once an owner exists, because the owner's public key is required to encrypt anything.
* Events used: `qr`, `loading_screen`, `authenticated`, `auth_failure`, `ready`, `change_state`,
  `disconnected`, `message_create` (fires for incoming **and** outgoing messages, so it is the single source for new
  messages), `message_ciphertext`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`,
  `message_reaction`, `message_ack`, `chat_removed`, `chat_archived`, `group_join`, `group_leave`,
  `group_update`, `contact_changed`. All handlers are idempotent upserts keyed by the serialized message ID.
* **Media is downloaded immediately** on `message_create`, because after a revoke it can no longer be
  fetched. The queue runs at concurrency 2 (live before history), up to 4 attempts with backoff
  5 s/30 s/2 min/10 min. The download happens inside the page (same internals as whatsapp-web.js) and is pulled
  over CDP in 2 MiB slices that are encrypted straight to disk. Every WhatsApp call is raced against a timer
  (20 s poke, 120 s download, 180 s overall), because `downloadMedia()` can hang forever.
  Media larger than `MEDIA_MAX_MB` is `too_large`. History media whose CDN copy expired (stage `NEED_POKE`
  after a download attempt, observed for media older than about 2–4 weeks) becomes `unavailable` after 2 tries.
  Downloads pause while the data filesystem has less than 2 GB free. Failed, too-large, skipped or unavailable
  media can be retried from the UI.
* **View-once** (`isViewOnce` or a view-once wrapper type) → stored with `media_status='view_once'`. No download,
  no thumbnail. The UI shows a "View-once media is not logged" placeholder.
* Revoke: `message_revoke_everyone(after, before)` → mark the original row `deleted_at=now`, `deleted_by`.
  If the original was never logged and `before` is present, insert it first.
  If both are missing, insert a stub row flagged deleted with `body=null`.
* Edit: `message_edit(msg, newBody, prevBody)` → push `prevBody` into `message_edits` (dedupe), set
  `body=newBody` and `edited_at`.
* History: after the first `ready` (until `app_state.initial_sync_done` is set), fetch each chat's last
  `HISTORY_PER_CHAT` messages (default 200, via `pageapi.fetchMessages`) and upsert them with `source='history'`.
  History media is queued at low priority, depending on the setting. Deleting `initial_sync_done` re-imports.
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
* Brute force (`auth/throttle.ts`): every credential check (login, TOTP, password re-entry, recovery) is
  *charged before* scrypt runs, synchronously, so parallel requests cannot race past a lock. The lock is **per IP**
  (after 5 failures: 30 s … 1 h exponential), so one attacker cannot lock the owner out. It is backed by a **global**
  per-account counter in the DB (after 50 consecutive failures from any IPs: one attempt per 30 s … 15 min). Recovery
  keys (256-bit) only use the per-IP limit. Route rate limits come on top. All auth events go to `audit_log`.
* TOTP codes are consumed atomically (`UPDATE … WHERE totp_last_step < step`), so a code works once even in
  parallel requests. Enabling 2FA needs the password (a stolen session alone can't lock the owner out). Wipe and
  recovery-key rotation need the password **and** the 2FA code when 2FA is enabled.
* After password changes, recovery, 2FA changes and session revocation, the SQLite WAL is checkpointed and
  truncated (`secure_delete=ON` zeroes freed pages), so superseded key wraps don't stay on disk.

### Sessions
* Cookie `__Host-wal_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`). Value is
  `b64url(sid32).b64url(secret32)`. The DB stores `sha256(sid)` and the owner private key encrypted under
  `HKDF(secret, "wal/v1/session")`. **A DB dump without a live cookie cannot decrypt anything.**
* Idle timeout `SESSION_IDLE_HOURS` (default 8) and absolute `SESSION_MAX_DAYS` (default 7). Sessions can be listed and revoked, including "log out everywhere".
  A password change revokes all other sessions.
* `COOKIE_SECURE=false` (dev/HTTP only) drops the `__Host-` prefix and `Secure`, and logs a loud warning.

### CSRF / request integrity
* "Is this an API request?" is decided from the **matched route** (`req.routeOptions.url`), never the raw URL.
  The router percent-decodes paths, so `/%61pi/...` must not skip the auth hook. A second `preHandler` layer
  re-checks the session for every matched non-public `/api` route. Absolute-form request targets are rejected.
* Requests whose TCP peer is the Chromium container are refused. Chromium shares the backend network with the
  app, but must never talk to the app.
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
contacts(id TEXT PRIMARY KEY, name_enc BLOB, pushname_enc BLOB, phone_enc BLOB /* migration 2 */,
         is_me INTEGER, is_business INTEGER, avatar_media_id INTEGER, avatar_checked_at INTEGER, updated_at)
messages(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT, from_me INTEGER, ts INTEGER, type TEXT,
         body_enc BLOB, meta_enc BLOB, thumb_enc BLOB, quoted_id TEXT,
         media_id INTEGER, media_status TEXT, media_attempts INTEGER, media_size INTEGER, media_w INTEGER,
         media_h INTEGER, media_duration INTEGER,
         is_view_once INTEGER, is_forwarded INTEGER, is_status INTEGER, ack INTEGER,
         deleted_at INTEGER, deleted_by TEXT, deleted_for_me_at INTEGER, edited_at INTEGER, last_edit_key TEXT,
         source TEXT, captured_at INTEGER, updated_at INTEGER)
  INDEX messages(chat_id, ts), INDEX messages(deleted_at) WHERE deleted_at IS NOT NULL
message_edits(id INTEGER PRIMARY KEY, message_id TEXT, body_enc BLOB, captured_at INTEGER)
reactions(message_id TEXT, sender_id TEXT, emoji_enc BLOB, ts INTEGER, removed_at INTEGER, PRIMARY KEY(message_id, sender_id))
media(id INTEGER PRIMARY KEY, path TEXT, key_id INTEGER, mime_enc BLOB, filename_enc BLOB, size INTEGER, created_at INTEGER)
```
Migrations live in `server/src/db/db.ts` (`MIGRATIONS`, append-only), are applied in a transaction at startup
and tracked in `schema_migrations`. Message ids are the rebuilt WA keys. Message bodies and their edit history share the
AAD context `msgbody|<messageId>`, so an edit can move the old ciphertext into `message_edits` without decrypting.

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
`PUBLIC_ORIGIN` (e.g. `https://wa.example.com`; optional in HTTP mode), `SETUP_TOKEN`, `VNC_PASSWORD`,
`COOKIE_SECURE` (`true` default | `auto` | `false`), `CADDY_CONFIG` (`Caddyfile` | `Caddyfile.http`),
`HTTP_PORT`/`HTTPS_PORT`, `HTTP_BIND`/`HTTPS_BIND` (bind address of the published ports), `WAL_VERSION` (image tag),
`SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`, `MEDIA_MAX_MB` (default 100), `HISTORY_PER_CHAT` (200),
`RECONCILE_MINUTES` (10), `CHROMIUM_HOST` (`chromium`), `CDP_PORT` (9223), `VNC_PORT` (5900),
`SCREEN` (`1280x800x24`), `LOG_LEVEL` (info), `TRUST_PROXY` (proxy hops: 1 = bundled Caddy, 2 = + external proxy).

## 10. Testing

* `server`: vitest. Covers crypto round-trips and tamper/AAD-mismatch failures, chunked range decrypt, auth flows through
  `fastify.inject` (signup gating, login, lockout, CSRF/Origin, session expiry, recovery), a route-table test
  asserting that every `/api` route except the public allowlist rejects anonymous requests, mapper fixtures for
  every message type, and revoke/edit/reaction ingest.
* `web`: vitest for the formatting parser (including injection attempts), `tsc --noEmit`, and a production build.
* `server/src/wa/client.test.ts` drives the real WaService event wiring with a fake whatsapp-web.js client
  (ordering, revoke, edit, reactions, states). `auth.test.ts` also covers encoded-path bypasses, parallel
  lockout races, TOTP replay races, WAL scrubbing and `COOKIE_SECURE=auto`.
* `scripts/smoke.sh` (23 checks: TLS incl. no-SNI, headers, cookies, CSRF/Origin, signup, WA reaches `qr`, VNC
  `RFB 003.00x`, no app egress, Chromium sandbox) and `scripts/smoke.sh --deploy` (the standalone layout).
* `scripts/dev/` has a full-UI browser walkthrough (61 steps) and a live-update (SSE) test. `scripts/wa-diagnose.js`
  checks a *running* instance against WhatsApp Web changes (see §11).

## 11. Deployment & operations

* **Images:** CI (`.github/workflows/ci.yml`) runs tests, then builds and publishes
  `ghcr.io/revocx35/wa_logger-{app,chromium,caddy}` (tags `latest`, `x.y.z`, `sha-…`) on pushes to `main` and `v*` tags.
  The packages are public. All GitHub Actions are pinned by commit SHA.
* **Topologies:** (a) from source: `docker-compose.yml` builds the images; (b) prebuilt: `deploy/docker-compose.yml`
  plus `seccomp-chromium.json` and `.env`; (c) either one in HTTP mode behind the user's TLS proxy
  (`setup.sh --http-only`); (d) an optional `docker-compose.override.yml` binds the four volumes to a dedicated,
  size-capped filesystem (README "cap storage").
* **Update:** `docker compose pull && docker compose up -d` (prebuilt) or `git pull && docker compose up -d --build`.
  The WhatsApp session survives restarts (it lives in the Chromium profile). Restarting only `app` does not touch
  Chromium: `docker compose up -d --no-deps app`.
* **Backups:** `app_data` (encrypted; useless without the password or recovery key) and `chromium_profile` (the live
  WhatsApp session: treat it as a credential).
* **When WhatsApp Web changes break something** (history import fails, names missing, media not downloading):
  run `docker compose exec -T app node - < scripts/wa-diagnose.js` on the host. It prints only aggregates (no
  content): WhatsApp Web version, chat counts, whether whatsapp-web.js chat helpers still work, whether rebuilt
  message keys still match `MsgKey.toString()`, media stages, and DB stats. Then check `docs/wwebjs-notes.md`.

## 12. Android client — `android_client/`

A native client for the same API (no WebView, no server changes needed). Kotlin 2.4, Jetpack Compose,
AGP 9.4 (built-in Kotlin), Gradle 9.8 (wrapper with pinned checksum), minSdk 26, compile/target SDK 37.
Package `io.github.revocx35.walogger` (debug builds get the `.debug` suffix and install side by side).
Current release: 0.1.1 (versionCode 2), confirmed working by the owner on a Samsung, One UI 8.5 / Android 16,
server in HTTP mode.

### Modules
* `core/` — pure Kotlin/JVM (no Android classes), so protocol code is tested without an emulator:
  * `Models.kt` mirrors `shared/api.d.ts`. Every field has a default where possible, unknown enum values fall
    back to a default (`coerceInputValues`), numbers that may be fractional are `Double` (media width/height).
  * `ApiClient` — OkHttp + kotlinx.serialization. Adds the browser-equivalent `Origin` header to requests
    for the configured server (the server's Origin/CSRF checks apply unchanged), `X-CSRF-Token` on non-GET,
    never follows redirects (a 3xx becomes an error that names the target), maps transport errors to
    `ApiException` codes (`network`, `tls_untrusted`, `tls`, `redirect`, `not_wa_logger`). `probe()` checks
    that `/api/state` really comes from wa_logger. **The whole request (send, body read, JSON decode) runs
    in `withContext(Dispatchers.IO)`**: callers are on Android's main thread, where socket reads throw
    `NetworkOnMainThreadException` (the 0.1.0 bug, see DEVLOG). `MainThreadNetworkTest` enforces this.
  * `EventStream` — SSE (`/api/events`) with backoff 3 s→30 s, 65 s read timeout (server heartbeat 20 s),
    stops on 401; `reopened` fires after a reconnect so screens reload what they missed.
  * `WaText` (1:1 port of `web/src/lib/waText.tsx`, same test cases, same linear-time guarantees, UTF-16
    indexing like JS; Extended_Pictographic table built in because Android's regex engine differs by version)
    and `Format` (port of `format.ts`; `colorFor` gives the web's exact colors).
  * `vnc/` — RFB 3.3/3.7/3.8 client over the `/api/vnc` WebSocket bridge: VNC auth with a built-in DES
    (not every Android provider has plain DES), Raw/CopyRect/ZRLE, DesktopSize/LastRect; the remote
    clipboard is skipped and never kept. Our pixel format is 32 bpp little-endian, so a ZRLE CPIXEL is B,G,R.
* `app/` — the Android UI:
  * `ui/theme` — the web's CSS tokens (`WaColors`, light/dark following the system) and the web's SVG icon
    paths (`WaIcons`, generated from `web/src/components/Icon.tsx` plus a few extras). Custom components
    (`ui/components`) reproduce `.btn`, `.pill`, `.badge`, `.chip`, `.search-box`, bubbles, etc.
  * Screens mirror the web pages. Layout switches at 900 dp like the web: bottom rail on phones (hidden in a
    chat), side rail + two panes on tablets. Navigation Compose with type-safe routes (`MainShell.kt`).
    Screens take small state interfaces (`ChatState`, `ChatListState`, `DeletedState`) so screenshot tests
    can render them with fake data.
  * `data/` — `AppGraph` (singletons; `ServerSession` per server with its `ApiClient`, `EventStream`, Coil
    image loader, shared audio player), `AppController` (the web's route guard: server → signup →
    login/recover → recovery key → link → main; events run only in the foreground while logged in),
    `SecureCookieJar` (session cookie AES-GCM-encrypted with a non-exportable Android Keystore key in
    `noBackupFilesDir`, loaded lazily on a network thread, never throws on OkHttp threads), `ServerTrust`
    (system CAs first; certificates the owner imports or confirms by SHA-256 fingerprint are trusted only
    for the configured server host; hostname verification unchanged), `Prefs`, `Diagnostics`.
  * `media/` — one shared ExoPlayer for voice notes, full-screen viewer (zoomable photos, streamed
    video/GIF via OkHttp data source with Range), save through the system file picker, "open with" through
    a FileProvider copy in the app cache (deleted at the next start).
  * `ui/vnc/VncView` — double-buffered bitmap, tap = click, drag = wheel scroll (pan when zoomed or
    view-only), pinch = zoom, keyboard bar that sends typed text as keysyms (needed for "Log in with phone
    number" when WhatsApp is on the same phone).

### Robustness and diagnostics
* App and session coroutine scopes carry a `CoroutineExceptionHandler` that records failures instead of
  crashing; view models report unexpected (non-API) errors through `ServerSession.fail()`.
* `Diagnostics` writes local crash reports (uncaught exceptions) and picks up ANR traces of the main thread
  from `ApplicationExitInfo` (Android 11+). The next start shows them with a Copy button (also Settings →
  App → Crash reports). Reports hold stack frames, exception types, sanitized messages (JSON input excerpts
  removed), app/Android version and phone model — never content — and are never sent anywhere. When the owner
  reports a problem, ask for this report first.
* Lists are de-duplicated before `LazyColumn` (duplicate keys crash Compose); jump-to-message uses
  `scrollToItem` + `scrollBy` (no negative offsets).

### Security choices
`FLAG_SECURE` on by default (switch in Settings → App), `allowBackup=false` + data extraction rules excluding
everything, no disk cache for media (Coil memory cache only, ExoPlayer without cache), user-installed CAs not
trusted (network security config), cleartext allowed by the platform config but gated in the app (explicit
confirmation for HTTP to a non-private address), only `http(s)` links are tappable, copied message text is
marked sensitive.

### Build, test, release
* Tests: `:core:test` (unit tests incl. the UI-thread rule, ZRLE/RFB/DES, MockWebServer client tests),
  `:app:testDebugUnitTest` (Robolectric renders of every main screen; `recordRoborazziDebug` writes PNGs to
  `app/build/screenshots/` to compare with the web's `docs/screenshots`), and `LiveServerTest` (opt-in via
  `WAL_IT_*` env vars) against a real stack: `scripts/smoke.sh --keep`, seed with `server/src/testutil/seed.ts`
  into the stack's `app_data` volume (`chown -R 10001:10001` afterwards), trust Caddy's `root.crt`.
* No device or emulator is available on the dev LXC (no KVM). Code that only misbehaves on Android
  (threading rules, Keystore, R8) can't be caught by the JVM tests, so reason about it explicitly.
* **R8 is disabled** for release builds (`isMinifyEnabled = false`): minified builds couldn't be verified
  (0.1.0's mapping renamed route classes; Navigation resolves route serializers reflectively). Re-enable
  only after testing a minified build on an emulator/device; `proguard-rules.pro` is kept for that.
* CI job `android`: `:core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` and uploads the
  debug APK artifact.
* Releases are manual (the signing key never goes to CI): bump `versionCode`/`versionName` in
  `app/build.gradle.kts`, build `assembleRelease` from a clean clone, `gh release create android-vX.Y.Z <apk>`
  with the APK and signing-certificate SHA-256 in the notes. Use the `android-v` tag prefix: plain `v*` tags
  make CI publish versioned server images. Updates must be signed with the same key (location in Claude's
  project memory, not in the repo).
