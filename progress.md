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
- [ ] Multi-lens security review (auth, crypto, web/XSS/CSRF, container/network, data handling) with adversarial verification
- [ ] Fix all confirmed findings, re-test
- [ ] `SECURITY.md` (threat model, what is/isn't encrypted, operational guidance)

## Phase 9 — Release
- [ ] `README.md` (install, first-run, backup, upgrade, troubleshooting)
- [ ] GitHub Actions CI (tests, typecheck, build)
- [ ] Publish to GitHub as `wa_logger` (private) and push

## Manual steps for the owner (cannot be automated here)
- [ ] Scan the WhatsApp QR code with the phone and verify live logging of a real conversation (send, edit, delete)
