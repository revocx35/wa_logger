# wa_logger — notes for Claude sessions

Read these first, every session:
- `ARCHITECTURE.md`: the design source of truth (containers, security model, crypto, DB schema, API, config,
  deployment & operations §11).
- `progress.md`: step checklist. Tick items as they're completed, in the same commit.
- `docs/DEVLOG.md`: what was done when, production incidents, lessons. Append a section for each session.
- `docs/wwebjs-notes.md`: facts about whatsapp-web.js and WhatsApp Web that the code relies on (including which
  library helpers are broken on current WhatsApp Web and why `wa/pageapi.ts` exists).

## Rules
- Security first: this app stores private messages. Never log or print message content, names, numbers,
  cookies or secrets (not even while debugging). Never render message text as HTML. Never weaken CSP, cookie
  flags, network isolation or the Chromium sandbox.
- `shared/api.d.ts` is the server↔web contract. Change it deliberately and update both sides.
- Never call `client.destroy()`/`logout()` on the whatsapp-web.js client: both close the remote Chromium.
- Don't use whatsapp-web.js chat helpers (`getChats`, `getChatById`, `getProfilePicUrl`, `Chat.fetchMessages`).
  Use `server/src/wa/pageapi.ts`. Message ids come from `mapper.msgKey()`.
- DB migrations are append-only (`server/src/db/db.ts`). Encrypted columns are AAD-bound to their row id, so ids
  can't be changed after the fact.
- Commits end with the Co-Authored-By trailer. CI must stay green: it publishes the GHCR images on `main`.

## Commands
- Server: `cd server && npm test && npm run typecheck` (install with `PUPPETEER_SKIP_DOWNLOAD=true npm ci`).
- Web: `cd web && npm test && npm run build`.
- Full stack from source: `scripts/smoke.sh` (23 checks). Standalone layout: `scripts/smoke.sh --deploy`.
- UI/SSE browser tests: `scripts/dev/README.md`. Sample data: `server/src/testutil/seed.ts`.
- Live instance health (read-only, aggregates only): `docker compose exec -T app node - < scripts/wa-diagnose.js`.

## Deployments
- The owner's production instance runs on a separate VM, not on this dev LXC. Connection details and update
  commands are in Claude's project memory (not in this public repo). Never overwrite a deployment's `.env` or delete its
  data without being asked.
- Updating a prebuilt deployment: `docker compose pull && docker compose up -d`. To restart only the app (keeps the
  WhatsApp session): `docker compose up -d --no-deps app`.

## Gotchas learned the hard way
- Inside `page.evaluate()` run via `tsx`, named helper functions get wrapped with `__name` (undefined in the page).
- Compose `configs.content` fails for `read_only` services, so the Caddyfiles are baked into the caddy image.
- Opening the site by IP means no SNI, so Caddy needs `default_sni`. Some browsers block `crossorigin` scripts on self-signed certs.
- A fresh WhatsApp link keeps syncing history for minutes, which is why the catch-up history passes exist (WaService).
