# wa_logger — notes for Claude sessions

Read these first, every session:
- `AGENTS.md`: stand-alone summary for any agent (layout, commands, conventions, never-do list, gotchas). Keep it and
  `ARCHITECTURE.md` updated in the same commit as the change.
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
- **Multi-user** (ARCHITECTURE §3, §6 "Multi-user isolation"): a gateway (`server/src/front/`) in front of one worker per
  user (`server/src/index.ts`, own unix user), started by a root supervisor (`server/src/supervisor/`), and a Go manager in the
  chromium container (`chromium/manager/`) that runs one browser per user. Keep tenants isolated: no shared files, sockets or
  secrets; workers get a from-scratch environment; `/internal/*` needs the worker token **and** `X-WAL-Scope: internal`
  (the gateway strips client `X-WAL-*`); the tenant cookie is only a hint. The two root processes have only
  `SETUID SETGID CHOWN KILL` and no DAC override: they create and chown top-level directories and do the rest *as the tenant's user*.
- `shared/api.d.ts` is the server↔web contract. Change it deliberately and update both sides.
- **Keep the mobile client in sync with the web UI.** Every user-facing change to the web UI (new page, section, setting,
  login/onboarding step, admin feature) must be ported to `android_client/` in the same piece of work: models in
  `core/Models.kt`, calls in `ApiClient`, screens in `app/.../ui/`, tests (`ApiClientTest`, a `ScreenshotTest` render) and
  the version bump. If something can't be ported, say so explicitly and note it in AGENTS.md. (Learned 2026-10-20: the
  multi-user Users page and the temporary-password step shipped web-only and the app only showed a hint.)
- Never call `client.destroy()`/`logout()` on the whatsapp-web.js client: both close the remote Chromium.
- Don't use whatsapp-web.js chat helpers (`getChats`, `getChatById`, `getProfilePicUrl`, `Chat.fetchMessages`).
  Use `server/src/wa/pageapi.ts`. Message ids come from `mapper.msgKey()`.
- Sending goes through `server/src/wa/walpage.ts` (WhatsApp Web's own send actions; notes in docs/wwebjs-notes.md
  "Sending"). It is injected as source text: keep it self-contained (`walpage.test.ts` runs the string in a bare `vm`).
  Never put message text in URLs or logs: JSON bodies only (files: raw body on `/api/uploads`).
- Calls go through `server/src/wa/callpage.ts` (WhatsApp Web's own calling; injected source text, self-contained like
  walpage.ts, tested in a bare `vm` by `callpage.test.ts`). Its audio hooks (virtual microphone, speaker tap) must stay
  installed at document start. Never record, store or log call audio, and never send audio when `setBridge` is off.
  Re-check the audio/video paths in the real Chromium image with `scripts/dev/call-audio.mts` / `call-video.mts` after
  touching it. Never record or store call video either.
- DB migrations are append-only (`server/src/db/db.ts`). Encrypted columns are AAD-bound to their row id, so ids
  can't be changed after the fact.
- Commits end with the Co-Authored-By trailer. CI must stay green: it publishes the GHCR images on `main`.
- Android (`android_client/`, ARCHITECTURE §12): all network I/O and JSON decoding off the main thread (ApiClient
  already runs requests on `Dispatchers.IO`; keep it that way and never read a response body elsewhere on the
  caller's thread). Nothing may throw on OkHttp threads (cookie jar, interceptors, listeners): it kills the app.
  Keep R8 off until minified builds are tested on a device/emulator. Never log message content there either.

## Commands
- Server: `cd server && npm test && npm run typecheck` (install with `PUPPETEER_SKIP_DOWNLOAD=true npm ci`).
- Web: `cd web && npm test && npm run build`.
- Android: `cd android_client && ./gradlew :core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
  (= the CI job; JDK 21 and SDK at /opt/android-sdk on this LXC). Screenshots: `./gradlew :app:recordRoborazziDebug`.
  Live end-to-end: `LiveServerTest` (see `android_client/README.md`). Release: ARCHITECTURE §12 "Build, test, release".
- Chromium manager: `cd chromium/manager && go test ./...` (Go at `/usr/local/go/bin`; also run when the image builds).
- Multi-user on a real stack: `scripts/dev/multiuser-e2e.mts` (command in its header; scratch compose project + `.env`, never the
  owner's deployment). Upgrade test: build an old commit's images in a `git worktree`, run it, seed it, then start the new
  compose on the same volumes (done 2026-10-20; it found the stale-`SingletonLock` bug).
- Full stack from source: `scripts/smoke.sh` (30 checks). Standalone layout: `scripts/smoke.sh --deploy`.
- UI/SSE browser tests: `scripts/dev/README.md` (`send-ui.mts`: sending end-to-end incl. a real voice recording;
  `call-ui.mts`: calls in the web UI; `call-audio.mts`: call audio inside the real Chromium image).
  Sample data: `server/src/testutil/seed.ts`.
- Live instance health (read-only, aggregates only): `docker compose exec -T -u 10001 app node - < scripts/wa-diagnose.js`
  (user N: `-u $((10100+N)) -e TENANT=N`).

## Deployments
- The owner's production instance runs on a separate VM, not on this dev LXC. Connection details and update
  commands are in Claude's project memory (not in this public repo). Never overwrite a deployment's `.env` or delete its
  data without being asked.
- Updating a prebuilt deployment: `docker compose pull && docker compose up -d`. To restart only the app (keeps the
  WhatsApp session): `docker compose up -d --no-deps app`.

## Gotchas learned the hard way
- Multi-user (details in AGENTS.md "Gotchas"): root processes can't touch tenant files (do it as the tenant's user); `HOME` must
  be set for workers; clear Chromium's `SingletonLock` as the instance user before each start (hostname changes when the
  container is recreated); `docker build` for the app/caddy/chromium images of an *old* checkout re-tags
  `wa_logger-*:local`: rebuild the new ones afterwards; the login routes allow 10 attempts / 15 min per IP, so repeated
  scripted logins need an app restart (the limiter is in memory).
- The dev LXC has 4 GB RAM: never run a Docker stack build/start and Gradle at the same time (the LXC froze once).
  Gradle is capped in `android_client/gradle.properties`; stop the smoke stack while Gradle runs.
- `android_client/core` mirrors `shared/api.d.ts` and ports `web/src/lib/{waText,format}`: change them together.
- The Android JVM tests can't see Android-only rules. 0.1.0 read responses on the main thread (NetworkOnMainThreadException)
  and every test passed. The LXC has KVM: run `:app:connectedDebugAndroidTest` on the emulator (AVD `wal_test`,
  Android 17) before releases. When the owner reports an app problem, still ask for the in-app crash report
  (Settings → App → Crash reports) before guessing.
- Android 17 / target SDK 37 blocks private-network connections without `ACCESS_LOCAL_NETWORK` ("Nearby devices"):
  0.1.x–0.2.0 couldn't reach a 192.168.x.x server there. Test new Android versions on the emulator.
- The root `.gitignore` ignores `data/`; android_client's Kotlin `data` package is re-included explicitly. Build from a
  fresh `git clone` before pushing (a local build passes with untracked or ignored files).
- Inside `page.evaluate()` run via `tsx`, named helper functions get wrapped with `__name` (undefined in the page).
- Compose `configs.content` fails for `read_only` services, so the Caddyfiles are baked into the caddy image.
- Opening the site by IP means no SNI, so Caddy needs `default_sni`. Some browsers block `crossorigin` scripts on self-signed certs.
- `TRUST_PROXY` is a hop count and must equal the real number of proxies (bundled Caddy = 1, + Nginx Proxy Manager = 2).
  NPM appends to a client-sent `X-Forwarded-For` rather than replacing it, so only the right-most hops are real; a
  "trust everything" setting would let clients pick their IP. Details in ARCHITECTURE.md §3 (HTTP mode).
- whatsapp-web.js may never emit `ready` (a stalled binding exposure). WaService completes the setup itself after
  60 s (`armReadyFallback`). Don't close tabs before ready.
- WhatsApp Web reloads its own tab when it updates: the library re-emits `authenticated` (→ state "authenticating")
  and later `ready` in the same connection. `resumeAfterReload` must bring the state back to "ready": media
  downloads and reconcile only run in "ready" (2026-10-15: stuck for a day, messages still logged, no media).
- A fresh WhatsApp link keeps syncing history for minutes, which is why the catch-up history passes exist (WaService).
