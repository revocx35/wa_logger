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
- [ ] `CLAUDE.md` pointer for future sessions
- [ ] `shared/api.d.ts` DTO contract between server and web
- [ ] Package manifests with pinned dependencies (`server/`, `web/`)
- [ ] Design review (security / WhatsApp feasibility / UX completeness) and incorporate findings

## Phase 2 — Infrastructure
- [ ] `chromium/Dockerfile` (Debian trixie, chromium, Xvfb, x11vnc, socat, fonts incl. emoji, non-root)
- [ ] `chromium/entrypoint.sh` supervisor (restart loops, stale lock cleanup, healthcheck)
- [ ] `chromium/seccomp-chromium.json` → Chromium sandbox ON (verified, no `--no-sandbox`)
- [ ] Root `Dockerfile` for app (multi-stage: web build → server build → slim runtime, non-root)
- [ ] `docker-compose.yml` (caddy/app/chromium, public/edge/backend/egress networks, hardening, limits, healthchecks)
- [ ] `caddy/Caddyfile` (auto HTTPS or internal CA, HTTP→HTTPS, security headers passthrough)
- [ ] `scripts/setup.sh` (generates `.env` with strong secrets, asks for site address)
- [ ] `.env.example`, `.gitignore`, `.dockerignore`

## Phase 3 — Server core
- [ ] Config parsing (zod) + redacting logger
- [ ] SQLite connection, migrations, repositories
- [ ] Crypto primitives, password KDF, keyring (X25519 + DEK rotation), field encryption, chunked media streams
- [ ] Auth: signup (setup token), login, logout(-all), recovery key, password change, lockout, audit log
- [ ] Sessions: cookie format, idle/absolute expiry, list/revoke, session-bound private key unlock
- [ ] CSRF (Origin + token), rate limits, security headers/CSP, error handling
- [ ] Optional TOTP 2FA (enroll/enable/disable, replay protection)

## Phase 4 — WhatsApp integration
- [ ] Browser connection (IP resolve, CDP connect, tab hygiene, disconnect-not-destroy)
- [ ] Client lifecycle + state machine + reconnect/backoff + status broadcasting
- [ ] Message mapper for all types (text, image, video, gif, audio/ptt, document, sticker, location, vcard/multi-vcard, poll, call log, system/notification, revoked, ciphertext, view-once placeholder)
- [ ] Ingest: create/edit/revoke-everyone/revoke-me/reaction/ack/chat & contact updates (idempotent)
- [ ] Media download queue (priority, size cap, retries, encryption to disk, thumbnails)
- [ ] Initial history sync + periodic reconcile (detect missed + revoked messages)
- [ ] Avatars (best-effort, fetched inside the browser)
- [ ] Status updates logging (toggle)

## Phase 5 — HTTP API
- [ ] `/api/state`, onboarding complete, WA status/restart/logout
- [ ] Chats list, messages paging (+ around), edits, deleted feed, search
- [ ] Media streaming with Range + safe content-type/disposition policy + retry
- [ ] SSE live events
- [ ] Settings, audit log, data wipe
- [ ] VNC credentials + authenticated WebSocket↔TCP bridge

## Phase 6 — Web UI
- [ ] App shell, routing guard, API client (CSRF header), SSE hook, theme (WhatsApp-like, light/dark)
- [ ] Signup (setup token), login (+TOTP), recover pages
- [ ] Onboarding: recovery key page, link page (noVNC + status pill + Complete button)
- [ ] Main: chat list (search, filters, deleted counts, avatars), chat view (bubbles, date separators, group sender names)
- [ ] Message renderers for all types + deleted/edited/forwarded/reactions/quoted/view-once/system
- [ ] Media: lightbox, video/audio players, documents, stickers
- [ ] Deleted messages feed, global search
- [ ] WA Web page (noVNC, view-only toggle, status, restart/relink)
- [ ] Settings (password, 2FA, sessions, recovery key, logging options, audit log, unlink, wipe)
- [ ] Responsive mobile layout

## Phase 7 — Testing & integration
- [ ] Server unit/integration tests green
- [ ] Web tests + typecheck + build green
- [ ] `docker compose build` + `up` healthy; end-to-end smoke test script passes (signup → WA QR visible → VNC bridge)

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
