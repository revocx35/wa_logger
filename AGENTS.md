# AGENTS.md — notes for AI coding agents

The full agent notes live in [CLAUDE.md](CLAUDE.md) (rules, commands, gotchas) and the design in
[ARCHITECTURE.md](ARCHITECTURE.md). Read both before changing anything. In short:

- **Build/test:** `cd server && npm test && npm run typecheck` · `cd web && npm test && npm run build` ·
  `cd android_client && ./gradlew :core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` ·
  full stack `scripts/smoke.sh` · browser tests in `scripts/dev/` (`send-ui.mts` for sending, `call-ui.mts` and
  `call-audio.mts` / `call-video.mts` for calls).
- **Where things are:** server `server/src` (WhatsApp side in `wa/`, sending in `wa/walpage.ts` + `wa/sender.ts`,
  calls in `wa/callpage.ts` + `wa/callbridge.ts` + `wa/calls.ts`, HTTP API in `api/`), web UI `web/src`, Android
  client `android_client/`, API contract `shared/api.d.ts`. authentik forward auth for the Android client:
  `docs/authentik.md` (`core/Authentik.kt` is the same file in insta_logger, web-ip-phone and RWR: change them together).
- **Never:** log message content/names/numbers/secrets, weaken CSP/cookies/sandbox/network isolation, call
  whatsapp-web.js `destroy()`/`logout()`, use its chat helpers, edit old DB migrations, put message text in URLs.
- **Calls** incl. video (web UI and Android client; wa_logger mobile can't): WhatsApp Web's own calling in the Chromium tab, audio
  bridged over `WS /api/calls/audio` (ARCHITECTURE §4 "Calls", §12 "Calls"). Never record or log call audio.
