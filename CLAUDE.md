# wa_logger — notes for Claude sessions

Read these first, every session:
- `ARCHITECTURE.md` — design source of truth (containers, security model, crypto, DB schema, API).
- `progress.md` — step checklist; tick items as they are completed, in the same commit.

Rules:
- Security first: this app stores private messages. Never log message content, names, cookies or secrets.
  Never render message text as HTML. Never weaken CSP, cookie flags, network isolation or the Chromium sandbox.
- `shared/api.d.ts` is the server↔web contract; change it deliberately and update both sides.
- Never call `client.destroy()` on the whatsapp-web.js client (it would close the remote Chromium).
- Server: `cd server && npm test && npm run typecheck`. Web: `cd web && npm test && npm run build`.
- Full stack: `docker compose up -d --build`, smoke test: `scripts/smoke.sh`.
- Install deps with `PUPPETEER_SKIP_DOWNLOAD=true` (Chromium lives in its own container).
