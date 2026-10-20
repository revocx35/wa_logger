# AGENTS.md — notes for AI coding agents

Stand-alone summary; the long forms are [CLAUDE.md](CLAUDE.md) (rules, commands, gotchas) and
[ARCHITECTURE.md](ARCHITECTURE.md) (design source of truth). Read ARCHITECTURE.md before changing anything structural,
and update it (and this file) in the same commit as the change.

## What this is
Self-hosted, encrypted WhatsApp logger. A real Chromium runs WhatsApp Web; the app records every message, edit, reaction and
media file. **Multi-user:** the first account is the admin; the admin creates users (temporary password → the user chooses their
own and scans their own QR code) and can give each a port. Every user is a tenant with its own worker process (own unix user,
own SQLite database, own keys), own Chromium (own unix user, own profile) and own WhatsApp link.

## Layout
```
server/src/
  index.ts            the tenant WORKER (one process per user; listens on a unix socket)
  front.ts, front/    the GATEWAY: only network listener; users, ports, admin API, proxy to workers (system DB)
  supervisor/         root process of the app container: starts gateway + workers under their own unix users
  api/ auth/ crypto/ db/ http/ wa/ vnc/   what a worker does (HTTP API, auth, envelope encryption, SQLite, WhatsApp, VNC bridge)
  testutil/           test harness, cookie-jar browser, seed data (not in the build)
chromium/             image: Debian + Chromium + Xvfb + x11vnc; manager/ = Go program that runs one browser per user
caddy/                TLS front; extra-ports.sh generates one site per EXTRA_PORTS port
web/src/              React SPA (pages/Admin.tsx = user management)
shared/api.d.ts       server↔web contract (type-only)
android_client/       native Android client (Kotlin/Compose); core/ mirrors shared/api.d.ts
scripts/              setup.sh (.env), smoke.sh (compose test), wa-diagnose.js, dev/ (browser + e2e scripts)
docker-compose.yml    builds from source;  deploy/docker-compose.yml = prebuilt GHCR images (keep them in sync)
```

## Commands
- Server: `cd server && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npm run typecheck` (≈190 tests, ~5 s).
- Web: `cd web && npm test && npm run build`.
- Chromium manager (Go, stdlib only): `cd chromium/manager && go test ./...` (also run in the image's build stage;
  Go is at `/usr/local/go/bin` on the dev LXC).
- Full stack from source: `scripts/smoke.sh` (`--deploy` = standalone layout; `--keep` leaves it running).
- Multi-user against a running stack: `scripts/dev/multiuser-e2e.mts` (header comment has the command). It checks unix users,
  permissions, capabilities, one browser per user, port policy and deletion for real.
- Android: `cd android_client && ./gradlew :core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`.
  Never run Gradle and a Docker stack build at the same time on the 4 GB dev LXC (it froze once).
- Health of a live instance: `docker compose exec -T -u 10001 app node - < scripts/wa-diagnose.js` (user N: `-u $((10100+N)) -e TENANT=N`).

## Conventions
- TypeScript ESM, strict; Fastify 5, zod on every body/query/param, better-sqlite3, vitest. Errors thrown as `AppError`
  (`errors.ts`); responses never contain internals. Comments explain *why*; match the surrounding density.
- DB migrations are append-only (`server/src/db/db.ts` for tenants, `front/db.ts` for the system DB). Encrypted columns are
  AAD-bound to their row id.
- Cookies: `__Host-wal_session` (worker) and `__Host-wal_tenant` (gateway; only selects the worker, not a credential).
- Tenant 1 (the first account) keeps the single-user layout: data in `/data`, uid 10001, browser profile `/data/profile`,
  uid 10002. Tenant n>1: `/users/<n>`, `/data/u<n>/profile`, uid `10100+n`. Ids are never reused.
- Commits end with `Co-Authored-By: Claude …`; commit as the GitHub noreply identity. CI must stay green (it publishes the images).

## Never
- Log or print message content, names, numbers, cookies, tokens or passwords. Render message text as HTML. Weaken the CSP,
  cookie flags, network isolation or the Chromium sandbox (`--no-sandbox`).
- Give the gateway, the supervisor or a worker anything it doesn't need: workers get a from-scratch environment (no
  `SETUP_TOKEN`, no `CONTROL_SECRET`), the gateway never holds keys or data, nothing but the gateway may call `/internal/*`
  (it needs the worker token **and** `X-WAL-Scope: internal`, and the gateway strips every client `X-WAL-*` header).
- Let one tenant reach another: no shared files, no shared sockets, no shared secrets, no cross-tenant queries. The tenant
  cookie must stay a *hint* (the worker validates the session), never a credential.
- Add capabilities to the app/chromium containers beyond `SETUID SETGID CHOWN KILL`, or run a worker/browser as root.
- Call whatsapp-web.js `client.destroy()`/`logout()` or its chat helpers (see CLAUDE.md); edit old migrations; put message
  text in URLs; overwrite a deployment's `.env` or data without being asked.
- Push or publish without the leak scan from the global instructions (IPs, secrets, history) and the owner's OK.

## Gotchas
- **Root has no DAC override in the two root processes** (capabilities are `SETUID SETGID CHOWN KILL` only): they cannot
  read, write, chmod or delete inside a tenant's directories. Create + chown top-level dirs, then do everything inside as
  that unix user (`runAs`, `find … -delete`, `rm -f` of stale `SingletonLock`/X sockets). Root also cannot `chmod` a directory
  it already handed over (chmod first, chown last). `kill` of another user's process needs `CAP_KILL`.
- A worker's unix user has no passwd entry: `HOME` must be set or Node's `os.homedir()` throws.
- Stale Chromium `SingletonLock` after a container is recreated (new hostname) makes the profile "in use by another computer":
  clear it as the instance's user before every start (this broke the upgrade test once).
- The supervisor joins the front's group (`setgroups`) to probe worker sockets (their directories are `0710 tenant:front`).
- Unix socket paths are ≤ ~104 bytes: tests use short temp dirs.
- Origins: when a port has a configured origin (PUBLIC_ORIGIN for the default port) the gateway tells the worker that scheme and
  host instead of the forwarded ones; Android/other clients must therefore use that exact origin.
- Behind NPM `TRUST_PROXY` must equal the real hop count (gateway counts it; workers trust one hop: the gateway). See ARCHITECTURE §3.
- Port ranges: `EXTRA_PORTS` must be one range for compose (`8101-8110`); the app accepts lists too, caddy's script too.
- `@fastify` rate limit is per process: the gateway and each worker count separately (login routes: 10/15 min per IP).
- Test users' passwords must not contain their username (policy); test ports must not collide with a running dev stack.
- Inside `page.evaluate()` run via `tsx`, named helpers get wrapped with `__name` (undefined in the page).
- The root `.gitignore` ignores `data/`; build from a fresh `git clone` before pushing.
