# wa_logger — Progress

Legend: `[x]` done · `[ ]` todo · `[~]` in progress / partial. Design details live in `ARCHITECTURE.md`.
Update this file whenever a step is completed.

## Phase 0 — Environment & feasibility spike
- [x] Install git, GitHub CLI, SSH key, GitHub auth (account `revocx35`)
- [x] Install Docker CE 29 + compose plugin in the LXC (verified `hello-world`)
- [x] Install Node 24 LTS + build tools on the host
- [x] Spike: Debian trixie Chromium 153 runs headful under Xvfb in Docker
- [x] Spike: Chromium sandbox needs user namespaces → works when seccomp allows them (custom profile needed)
- [x] Spike: headful Chromium ignores `--remote-debugging-address` → socat relay 9223→9222 works
- [x] Spike: CDP rejects non-IP `Host` headers → app must connect by resolved IP
- [x] Spike: whatsapp-web.js 1.34.7 connects to the remote Chromium and receives a WhatsApp QR code

## Phase 1 — Documentation & contracts
- [x] `ARCHITECTURE.md` (containers, security model, crypto, DB schema, API, config)
- [x] `progress.md` (this file)
- [x] `CLAUDE.md` pointer for future sessions
- [x] `shared/api.d.ts` DTO contract between server and web
- [x] Package manifests with pinned dependencies (`server/`, `web/`)
- [x] Design review: library internals verified against whatsapp-web.js source (destroy() closes browser → subclassed; gp2 events; chunked media)

## Phase 2 — Infrastructure
- [x] `chromium/Dockerfile` (Debian trixie, chromium, Xvfb, x11vnc, socat, fonts incl. emoji, non-root)
- [x] `chromium/entrypoint.sh` supervisor (restart loops, stale lock cleanup, healthcheck)
- [x] `chromium/seccomp-chromium.json` → Chromium sandbox ON (verified, no `--no-sandbox`)
- [x] Root `Dockerfile` for app (multi-stage: web build → server build → slim runtime, non-root)
- [x] `docker-compose.yml` (caddy/app/chromium, public/edge/backend/egress networks, hardening, limits, healthchecks)
- [x] `caddy/Caddyfile` (auto HTTPS or internal CA, HTTP→HTTPS, security headers passthrough)
- [x] `scripts/setup.sh` (generates `.env` with strong secrets, asks for site address)
- [x] `.env.example`, `.gitignore`, `.dockerignore`

## Phase 3 — Server core
- [x] Config parsing (zod) + redacting logger
- [x] SQLite connection, migrations, repositories
- [x] Crypto primitives, password KDF, keyring (X25519 + DEK rotation), field encryption, chunked media streams
- [x] Auth: signup (setup token), login, logout(-all), recovery key, password change, lockout, audit log
- [x] Sessions: cookie format, idle/absolute expiry, list/revoke, session-bound private key unlock
- [x] CSRF (Origin + token), rate limits, security headers/CSP, error handling
- [x] Optional TOTP 2FA (enroll/enable/disable, replay protection)

## Phase 4 — WhatsApp integration
- [x] Browser connection (IP resolve, CDP connect, tab hygiene, disconnect-not-destroy)
- [x] Client lifecycle + state machine + reconnect/backoff + status broadcasting
- [x] Message mapper for all types (text, image, video, gif, audio/ptt, document, sticker, location, vcard/multi-vcard, poll, call log, system/notification, revoked, ciphertext, view-once placeholder)
- [x] Ingest: create/edit/revoke-everyone/revoke-me/reaction/ack/chat & contact updates (idempotent)
- [x] Media download queue (priority, size cap, retries, encryption to disk, thumbnails)
- [x] Initial history sync + periodic reconcile (detect missed + revoked messages)
- [x] Avatars (best-effort, fetched inside the browser)
- [x] Status updates logging (toggle)

## Phase 5 — HTTP API
- [x] `/api/state`, onboarding complete, WA status/restart/logout
- [x] Chats list, messages paging (+ around), edits, deleted feed, search
- [x] Media streaming with Range + safe content-type/disposition policy + retry
- [x] SSE live events
- [x] Settings, audit log, data wipe
- [x] VNC credentials + authenticated WebSocket↔TCP bridge

## Phase 6 — Web UI
- [x] App shell, routing guard, API client (CSRF header), SSE hook, theme (WhatsApp-like, light/dark)
- [x] Signup (setup token), login (+TOTP), recover pages
- [x] Onboarding: recovery key page, link page (noVNC + status pill + Complete button)
- [x] Main: chat list (search, filters, deleted counts, avatars), chat view (bubbles, date separators, group sender names)
- [x] Message renderers for all types + deleted/edited/forwarded/reactions/quoted/view-once/system
- [x] Media: lightbox, video/audio players, documents, stickers
- [x] Deleted messages feed, global search
- [x] WA Web page (noVNC, view-only toggle, status, restart/relink)
- [x] Settings (password, 2FA, sessions, recovery key, logging options, audit log, unlink, wipe)
- [x] Responsive mobile layout

## Phase 7 — Testing & integration
- [x] Server unit/integration tests green
- [x] Web tests + typecheck + build green
- [x] `docker compose build` + `up` healthy; end-to-end smoke test script passes (signup → WA QR visible → VNC bridge)

## Phase 8 — Security review & hardening
- [x] Multi-lens security review (auth, crypto, web/XSS/CSRF, container/network, data handling) with adversarial verification
  - fixed: CRITICAL percent-encoded path (`/%61pi/...`) bypassed the auth/CSRF hook → route-based check + second layer
  - fixed: lockout race (parallel guesses) → attempts charged before scrypt; per-IP + global throttle (no owner DoS)
  - fixed: TOTP code replay race → atomic step consumption; 2FA enable needs the password; wipe/rotate need 2FA
  - fixed: ReDoS in vCard name regex (server event-loop freeze) and quadratic formatter (UI freeze)
  - fixed: superseded key wraps lingering in the SQLite WAL → checkpoint+truncate after sensitive changes
  - fixed: media file swap on disk not detected → file id checked against the DB path
  - fixed: CR/LF allowed in media `codecs` parameter (header injection) → spaces only
  - fixed: Chromium could call the app API over the backend network → requests from Chromium refused
  - fixed: crashed/closed WhatsApp tab went unnoticed (silent logging stop) → page error/close handlers + watchdog
  - fixed: X-Forwarded-For trusted beyond one hop; SSE/VNC stayed open ≤30 s after revocation; Caddy slowloris timeouts
- [x] Fix all confirmed findings, re-test (83 server + 10 web tests, 22/22 smoke checks)
- [x] `SECURITY.md` (threat model, what is/isn't encrypted, operational guidance)

## Phase 9 — Release
- [x] `README.md` (install, first-run, backup, upgrade, troubleshooting)
- [x] GitHub Actions CI (tests, typecheck, build)
- [x] Publish to GitHub as `wa_logger` (private) and push — https://github.com/revocx35/wa_logger (CI green)

## Phase 10 — Standalone deployment
- [x] `caddy/Dockerfile` (Caddyfile baked in, read-only friendly); root compose builds it
- [x] `deploy/docker-compose.yml` using prebuilt GHCR images (+ `seccomp-chromium.json` + `.env` only)
- [x] `setup.sh` works standalone (writes `.env` in the current directory outside a checkout)
- [x] CI publishes `wa_logger-app`, `wa_logger-chromium`, `wa_logger-caddy` to GHCR on `main` and `v*` tags; validates both compose files
- [x] `scripts/smoke.sh --deploy` tests the standalone layout from an empty directory (22/22)
- [x] README: both install options + full example compose file
- [x] Fix: TLS handshake failed when the site is opened by IP (no SNI) → Caddy `default_sni`; smoke check added (23/23)
- [x] Deployed on this LXC: /opt/wa_logger (prebuilt images) at https://192.168.68.23
- [x] Fix (found after the first real link): history import failed — whatsapp-web.js chat helpers throw on current
      WhatsApp Web (getChatModel IDB error for ~90% of chats). Chats/contacts/history/avatars are now read directly
      from WhatsApp Web's models (`wa/pageapi.ts`); LID contacts get their phone number (encrypted) as name fallback
- [x] Fix: message keys lost `_serialized` on current WhatsApp Web → rebuilt from parts (matches MsgKey.toString()
      for 100% of messages); media downloads, quotes and reactions work again
- [x] Fix: media queue could stall (WhatsApp's downloadMedia can wait forever) → in-page + Node-side timeouts;
      history media whose CDN copy expired (stage NEED_POKE after a download attempt) is marked unavailable after
      2 tries instead of blocking the queue (Retry button stays available)

## Phase 11 — HTTP mode behind a user's reverse proxy
- [x] `caddy/Caddyfile.http` (plain HTTP, trusted_proxies private_ranges) selectable via `CADDY_CONFIG`
- [x] `COOKIE_SECURE=auto` (per-request Secure/__Host- cookie + HSTS), `TRUST_PROXY` hop count
- [x] `setup.sh --http-only`; HTTPS port bound to localhost in HTTP mode
- [x] Tests: auto cookie mode over HTTP and via simulated TLS proxy; manual stack test (real client IP recorded)
- [x] Web: no `crossorigin` on the same-origin bundle + visible loading fallback (blank page on Android w/ self-signed cert)

## Phase 12 — Production follow-ups & documentation
- [x] Catch-up history passes (first 3 h after linking) — a fresh link imported only ~8% of history on the first pass
- [x] Fallback when whatsapp-web.js never emits `ready` (stalled binding exposure) + no tab closing before ready
- [x] `scripts/wa-diagnose.js` (read-only health check of a running instance vs. WhatsApp Web changes)
- [x] `scripts/dev/` (UI walkthrough, live-update test) + README; `docs/DEVLOG.md`; ARCHITECTURE §11; CLAUDE.md
- [x] Old LXC deployment and its data deleted (production runs on the owner's VM, HTTP mode behind their proxy)

## Phase 13 — Native Android client (`android_client/`)
- [x] Gradle project: `core` (pure Kotlin/JVM) + `app` (Compose); wrapper with pinned checksum
- [x] core: API models/client (Origin + CSRF), SSE event stream, WhatsApp formatter + formatting ports, RFB/VNC client (ZRLE, DES)
- [x] app: web design tokens + icons, all pages (connect, signup, login, recover, recovery key, link, chats, chat, deleted, search, WA Web, settings)
- [x] Native media (photo viewer, streamed video/GIF, voice player, stickers, save/open documents), native VNC view with touch + keyboard
- [x] Security: Keystore-encrypted session cookie, no backups, FLAG_SECURE default, server-scoped certificate trust, HTTP gating, no media disk cache
- [x] Tests: 25 core unit tests, 11 screenshot renders (Robolectric/Roborazzi), live end-to-end test against the smoke stack (incl. real x11vnc)
- [x] CI `android` job (tests, lint, debug APK artifact); signed release build (key kept outside the repo)
- [x] 0.1.1: network reads off the main thread (fixes messages not loading / crashes / ANR on a real phone), crash & ANR reports, R8 off
- [x] Owner confirmed 0.1.1 works on the phone (Samsung, One UI 8.5, HTTP mode)
- [x] 0.2.0: auto-save new photos (optionally videos/status) to the phone; server `GET /api/media-feed`
- [x] 0.3.0: auto-save option "only disappearing-message chats" (server stores `ephemeral_sec`); Android 17 local network permission (found on the emulator)
- [x] Emulator on this LXC (KVM): on-device tests + adb walkthrough of auto-save incl. the background job
- [x] 0.4.0: multi-select photos/videos in a chat → save to the gallery at once (tested on the emulator)
- [ ] Verify a minified (R8) release build on the emulator
- [x] Web: select photos/videos in a chat → "Download ZIP" (server `GET /api/media-zip`, streaming ZIP writer `http/zip.ts`) to verify release builds, then re-enable R8

## Phase 14 — Sending (2026-10-16)
- [x] Server: send through WhatsApp Web's own send actions (`wa/walpage.ts`, injected at every document start) — text,
      replies, media/files (raw upload → chunked into the page), voice notes, reactions, edit, delete for everyone,
      read receipts, new chat by number; sent media stored from the upload; 300 sends/hour cap; audit entries
- [x] API + tests (`api/send.test.ts`, `wa/walpage.test.ts` runs the injected source against fake WhatsApp modules)
- [x] Web: composer (Enter/Shift+Enter, reply/edit bars, attach with caption, voice notes with WebM→Ogg remux),
      message menu (react, reply, copy, edit, delete for everyone), New chat, read-receipts setting
- [x] Browser end-to-end `scripts/dev/send-ui.mts` (17 steps, real MediaRecorder voice note decoded as Ogg/Opus)
- [x] Android client: composer, message actions, new chat, voice notes
- [ ] Owner: send a first real message / photo / voice note from the web UI and the Android client
- Calls: Phase 15 (web UI); the standalone mobile app can't (docs/wwebjs-notes.md "Calls")

## Phase 15 — Voice calls (2026-10-17)
- [x] Page code `wa/callpage.ts`: call monitor + start/answer/decline/hang up through WhatsApp Web's own VoIP functions
      (from wa2sip), virtual microphone, speaker tap, popout-window hooks, no document PiP; `wa/callbridge.ts` (CDP
      bindings, audio pump, trusted click with fallback); `wa/calls.ts` (state machine, one audio client, hourly cap)
- [x] API: `GET /api/calls/current`, `POST /api/chats/:chatId/call`, `POST /api/calls/:id/accept|reject|hangup`,
      `WS /api/calls/audio`, SSE `call`; Chromium `--autoplay-policy=no-user-gesture-required`
- [x] Web: call panel (ringing, ringback, mute, timer, join/move audio), call button in one-to-one chats, AudioWorklet
- [x] Tests: `callpage.test.ts` (vm), `api/calls.test.ts`, `callWorklet.test.ts`; real Chromium image
      `scripts/dev/call-audio.mts` (12 checks), browser end-to-end `scripts/dev/call-ui.mts` (24 steps)
- [x] Read-only check of the live instance: web calling enabled for the account, all modules present
- [ ] Owner: a first real call from the web UI (outgoing and incoming); watch `docker compose logs app`
- [x] Android client 0.6.0: calls (AudioRecord/AudioTrack over the audio WebSocket, call panel, call button, foreground
      service while a call goes on); tested on the emulator against `call-ui.mts` (`SERVE=1`)
- wa_logger mobile can't (Android WebView isn't cross-origin isolated)

## Phase 16 — Video calls (2026-10-17)
- [x] Page: virtual camera (canvas capture tracks fed by WebCodecs-decoded frames), tap of WhatsApp's renderer
      registry (`onVideoFrameWasmToJs`: H.264 passed through, raw frames VP8-encoded), video start/answer, camera
      on/off like WhatsApp's button, key-frame requests; snapshot `selfVideo`/`peerVideo`
- [x] Server: `WS /api/calls/video` (12-byte frame header), `POST /api/calls/:id/video`, `{video}` on start/accept;
      `Permissions-Policy: camera=(self)`; Chromium no-background-throttling flags (video calls pop out)
- [x] Web: video call screen, video-call button, Answer with video, camera toggle, minimize
- [x] Tests: vm + API tests; `scripts/dev/call-video.mts` (real image, real H.264/VP8, 9 checks); `call-ui.mts` (39 checks)
- [ ] Owner: a first real video call
- [x] Android client 0.7.0 video (Camera2 → MediaCodec H.264, MediaCodec decoder with fallback, video screen);
      tested on the emulator against `call-ui.mts` (`SERVE=1`, real H.264 from the test browser)

## Phase 17 — Multiple users (2026-10-20)
- [x] Design: gateway + one worker per user (own unix user, own DB/keys) + root supervisor; Go manager in the chromium
      container with one Xvfb/Chromium/x11vnc per user under its own unix user and per-instance bearer tokens
- [x] Worker: unix socket + gateway token/scope, `/internal/*`, temporary-password claim flow (new account / reset with
      recovery key / wipe), `pending_claim` migration, throttle on the pending credential, `verify`/`ping`/`whoami`
- [x] Gateway: system DB (users, ports, admin log), listeners per port, port + tenant-cookie policy, streaming proxy and
      WebSocket tunnel, forwarding-header policy, admin API (users, ports, reset, delete, audit), legacy account adoption
- [x] Supervisor (spawn/stop/remove/reset-browser over a control socket) and Chromium manager (Go; ensure/restart/delete,
      DevTools allowlist relay, VNC tunnel, on-link bind)
- [x] Web: choose-your-own-password step, admin Users page (users, ports, reset/delete with re-auth, log)
- [x] Compose/Caddy: capabilities, volumes, tmpfs, extra ports (`EXTRA_PORTS`/`EXTRA_BIND`), `CONTROL_SECRET` (falls back
      to `VNC_PASSWORD`), caddy `extra-ports.sh`; `setup.sh`, `.env.example`, `smoke.sh` (35 checks), diagnose script
- [x] Tests: worker (multiuser.test.ts), gateway (26), supervisor (5), Go manager; `scripts/dev/multiuser-e2e.mts` (32 checks on a
      real stack); Playwright walkthrough of the new screens; upgrade test from a 0.8-era single-user volume pair
- [ ] Owner: update the production VM (README "Upgrading from a single-user release"), create the friend's user and
      port, point the second proxy host at it (no authentik), scan the friend's QR code with their phone
- [ ] Android: sign-in after a temporary password is only possible in the web UI (the app shows a hint); a native
      choose-your-password screen is not built

## Next ideas (not started)
- Android: push notifications for deletions (needs a server-side push channel; SSE only runs in the foreground)
- Retry expired history media via WhatsApp's phone re-upload ("media retry") instead of marking it unavailable
- Poll vote tallies (`vote_update` events) and group participant lists
- Export (encrypted archive) / import for moving instances without copying Docker volumes
- arm64 images (CI currently builds linux/amd64 only)

## Manual steps for the owner (cannot be automated here)
- [x] Scan the WhatsApp QR code with the phone (done on the VM; live messages are being logged)
- [ ] Send / edit / delete-for-everyone a test message and confirm it stays visible (Deleted page)
