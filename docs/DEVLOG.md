# Development log

Chronological notes: what was built, why, what broke in production and what was learned. Newest session
last. The design itself lives in `ARCHITECTURE.md`, and the step checklist in `progress.md`.

## 2026-09-24 — initial build, hardening, first production deployment

### Environment
- The build host was an Ubuntu 26.04 Proxmox LXC. Installed there: Docker CE 29 + compose, Node 24, gh CLI.
  Docker works in the LXC (nesting enabled).
- Feasibility spike before any design work:
  - Debian trixie Chromium runs headful under Xvfb.
  - Its sandbox needs user namespaces, so a custom seccomp profile is used instead of `--no-sandbox`.
  - Headful Chromium ignores `--remote-debugging-address`, hence the socat relay.
  - CDP rejects Host headers that are not IPs, so the app connects by IP.
  - whatsapp-web.js 1.34.7 can drive a *remote* browser (`puppeteer.browserURL`).

### Build (in order)
1. Docs first: `ARCHITECTURE.md`, `progress.md`, `shared/api.d.ts`, `CLAUDE.md`.
2. Chromium container: sandbox ON, a URL policy allowing only WhatsApp, VNC, CDP relay, and non-root with a read-only root filesystem.
3. Server core: config, redacting logger, SQLite schema + repository, envelope crypto (X25519 ECIES DEKs,
   AES-GCM fields with AAD binding, chunked media format with Range support).
4. Auth: setup-token signup, scrypt, sessions (cookie = sid.secret; the DB stores only a hash), CSRF + Origin checks,
   TOTP, recovery key, security headers.
5. WhatsApp integration: connected client (`destroy()` overridden), mapper, idempotent ingest, media queue,
   history import + reconcile, avatars.
6. API (chats, messages, media with Range, search, deleted feed, SSE, VNC bridge, admin), then the React UI.
7. Compose stack (Caddy/app/chromium; public/edge/backend/egress networks, only Caddy publishes ports),
   `setup.sh`, `smoke.sh`, CI, and publishing the repo (public).

### Security review (3 parallel reviewers + own follow-up) — all fixed and tested
- **Critical:** `/%61pi/...` (a percent-encoded path) skipped the auth/Origin/CSRF hook, because it checked the raw URL
  while the router decodes paths. API requests are now identified by the matched route (`req.routeOptions.url`),
  a second `preHandler` layer re-checks the session, and absolute-form request targets are rejected.
- Lockout race: parallel guesses bypassed the counter. Attempts are now charged *before* scrypt, synchronously,
  with per-IP locks plus a global cap (`auth/throttle.ts`), so one attacker can't lock the owner out either.
- TOTP replay race: the used step is now consumed atomically. Enabling 2FA needs the password; wipe and rotation need the password + TOTP.
- ReDoS: a vCard regex could freeze the server for about 78 s, and the formatter could freeze the UI. Both are now linear-time with size caps.
- WAL retained superseded key wraps: the WAL is now checkpointed and truncated after sensitive changes.
- Other fixes: a media file swap on disk went undetected; CR/LF could enter the media `codecs` header; Chromium could call the app API;
  a crashed or closed WhatsApp tab went unnoticed (now a watchdog); X-Forwarded-For hop trust; SSE/VNC stayed open after revocation; Caddy timeouts.

### Deployment work
- Standalone deploy: prebuilt GHCR images plus `deploy/docker-compose.yml`. Caddy got its own image, because compose
  `configs.content` can't be used with `read_only` containers.
- The TLS handshake failed when the site was opened **by IP**: browsers send no SNI, so the fix was `default_sni {$SITE_ADDRESS}`.
- A blank page on Android with the self-signed certificate: the same-origin bundle no longer carries `crossorigin`, and
  `index.html` shows a CSS-only loading fallback. The owner then chose **HTTP mode** behind their own TLS proxy:
  `Caddyfile.http`, `COOKIE_SECURE=auto`, `TRUST_PROXY=2`, `setup.sh --http-only`.
- Moved from the LXC to the owner's VM (Ubuntu 26.04, also runs Vaultwarden on :8080). Data lives on a dedicated LV
  (50% of the free VG space, about 318 GB) bound via `docker-compose.override.yml`. The app pauses media downloads below 2 GB free.
  After the move, the owner asked for a fresh instance (new signup and link) in HTTP mode. The old LXC data was deleted.

### Production incidents from the first real WhatsApp account (WhatsApp Web 2.3000.1048x)
All of these were invisible in tests (they only happen with real WhatsApp Web) and were diagnosed with read-only
CDP probes, now packaged as `scripts/wa-diagnose.js`:
1. **History import failed completely** ("sync failed", empty chat list). whatsapp-web.js `getChats()` goes through
   `getChatModel`, which throws an IndexedDB DataError for about 90% of chats, and `Promise.all` loses them all.
   Fix: `wa/pageapi.ts` reads chats, contacts, history and avatars directly from WhatsApp Web's models.
2. **Message keys lost `_serialized`**: messages were stored under the bare stanza id, so media, quotes and reactions
   could not be matched. Fix: `mapper.msgKey()` rebuilds the key (verified identical to `MsgKey.toString()` on 3570/3570
   messages). The rows already imported with bad keys were deleted and re-imported (nothing unique was lost).
3. **LID ids**: one-to-one chats and group members are `@lid`, with no phone number in the id. The phone is resolved via
   `toPn`/`phoneNumber` and stored encrypted as the name fallback (migration 2).
4. **Media queue stalled**: `downloadMedia()` can hang forever. Every call is now raced against timers.
   Expired history media (`NEED_POKE` after a download attempt, a CDN 404; WhatsApp Web only re-requests it from
   the phone on a manual click) is marked `unavailable` after 2 tries instead of blocking the queue.
5. **Too little history on a fresh link**: the first import runs right after "ready", while WhatsApp is still
   syncing history from the phone (a fresh instance got 269 messages instead of about 3300). Fix: three extra catch-up
   history passes, one per reconcile tick during the first 3 hours after linking.

6. **"ready" never came after a restart** (after WhatsApp Web auto-updated to 2.3000.1048389532): whatsapp-web.js
   stalled while exposing its 16th page binding (`onCiphertextFailedEvent`), so its store listeners, `ready`, history
   import and media downloads never happened (no error logged). Likely a race with the app closing a spare tab
   during that setup. Fix: the WhatsApp tab is only brought to front until ready (stray tabs are closed in onReady), and a
   fallback runs 60 s after `authenticated`: if the page is healthy, it completes `attachEventListeners()` itself (existing
   bindings are skipped; duplicate listeners are harmless because ingest is idempotent) and continues as ready.
   Diagnosed by listing which `window.on*` bindings existed.

### Lessons / rules for future work
- WhatsApp Web changes break whatsapp-web.js helpers silently. Prefer direct, defensive model reads, isolate errors
  per chat, and verify assumptions against a live page (`scripts/wa-diagnose.js`) before and after upgrades.
- Test against the way users actually deploy: by IP address, on phones, behind their own proxy.
- Never print message content during diagnosis. Aggregate counts are enough.
- Data that is encrypted with the row id in the AAD can't be re-keyed without the owner's key: get the ids right before importing.

### Not verified yet
- Real-world behaviour of edits, revokes and reactions for *live* messages on the owner's account. Unit and
  fake-event tests pass; the owner should send, edit and delete a test message.

## 2026-09-25 — native Android client

### What was built
- `android_client/`: Kotlin + Jetpack Compose app with the web UI's design (CSS tokens, SVG icons, bubbles,
  badges, pills, 900 dp breakpoint), not a WebView wrapper. Pure-JVM `core` module (API, SSE, formatter,
  RFB) so the protocol code is testable without an emulator; `app` module for the UI.
- WA Web is a native VNC client (RFB over the existing `/api/vnc` WebSocket bridge, ZRLE decoding, VNC auth
  with a built-in DES because not every Android provider exposes plain DES). Touch: tap = click, drag = wheel
  scroll, pinch = zoom; a keyboard bar sends typed text (needed for "Log in with phone number" when the
  phone with WhatsApp is the same phone running the app).
- No server changes were needed: the app sends the same `Origin` a browser would, so the existing
  Origin/CSRF checks apply unchanged.

### Verification
- No KVM on the LXC, so no emulator. Instead: core unit tests (formatter tests ported from the web,
  `colorFor` parity values computed from the web code, ZRLE against a test encoder, a scripted RFB server,
  DES against the JDK + FIPS vector, MockWebServer for the client), Robolectric/Roborazzi renders of every
  main screen compared by eye with `docs/screenshots` (phone, dark, tablet two-pane), and `LiveServerTest`
  against a real smoke stack with seed data: login, CSRF, decrypted chats/edits/quotes, Range media,
  SSE, a real x11vnc session (the decoded framebuffer showed WhatsApp Web's QR page), logout.

### Incident
- The LXC froze and had to be rebooted from Proxmox while `scripts/smoke.sh` was building the three images
  and Gradle + Robolectric were running at the same time (4 GB RAM). Now: Gradle heap capped, Kotlin
  compiled in-process, and Docker builds and Gradle are run one after the other.

### Not verified yet
- Running on a real phone (no device/emulator here), release build (R8) behaviour on device.
