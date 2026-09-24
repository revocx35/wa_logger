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

## Next ideas (not started)
- Retry expired history media via WhatsApp's phone re-upload ("media retry") instead of marking it unavailable
- Poll vote tallies (`vote_update` events) and group participant lists
- Export (encrypted archive) / import for moving instances without copying Docker volumes
- arm64 images (CI currently builds linux/amd64 only)

## Manual steps for the owner (cannot be automated here)
- [x] Scan the WhatsApp QR code with the phone (done on the VM; live messages are being logged)
- [ ] Send / edit / delete-for-everyone a test message and confirm it stays visible (Deleted page)
