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

## 2026-09-25 — Android 0.1.1: fixes for the first real-phone report

The owner installed 0.1.0 on a Samsung (One UI 8.5 / Android 16, server in HTTP mode): login worked, but
messages didn't load, the app crashed now and then, and it sometimes showed "not responding" on start.

- **Root cause:** `ApiClient` resumed on the caller's dispatcher (the main thread) after the HTTP call and
  read and decoded the response body there. Android forbids socket reads on the main thread
  (`NetworkOnMainThreadException`): small responses (login) happened to be buffered already, larger ones
  (chat list, message pages) failed, and uncaught cases crashed the app. The whole request now runs on
  `Dispatchers.IO`. `MainThreadNetworkTest` recreates the Android rule on the JVM (sockets refuse reads on
  the "UI" thread); it fails on the old code and passes now. The JVM tests had missed it because the JVM
  has no such rule.
- Startup: the Keystore-encrypted cookie store is loaded lazily on a network thread instead of in
  `Application.onCreate`. Cookie persistence failures no longer throw on OkHttp threads.
- Safety net: app/session coroutine scopes record unexpected failures instead of crashing; view models
  record unexpected errors. New local **crash/ANR reports** (uncaught exceptions + `ApplicationExitInfo`
  ANR traces of the main thread), shown on the next start with a Copy button; no message content.
- Smaller: jump-to-message no longer uses a negative scroll offset; list items are de-duplicated (duplicate
  keys crash LazyColumn); media width/height accepted as decimals.
- R8 is disabled for release builds until a device/emulator can verify minified builds (0.1.0's mapping
  showed renamed route classes; navigation resolves route serializers reflectively).
- Verification: unit + screenshot tests, lint, and the live end-to-end test against a fresh smoke stack.
  Still not run on a device (no KVM on the LXC; the owner plans a bigger server).
- The owner installed 0.1.1 and confirmed it works (chats and messages load, no crashes).

## 2026-10-10 — media downloads stopped ("stuck downloading")

The owner reported that images were stuck in "downloading". On the live instance, the last media download was on
2026-10-04 09:42. After that, 105 downloads failed that day and 46 stayed `pending` without being processed.

- **Root cause:** WhatsApp Web 2.3000.1049880737 made `WAWebDownloadManager.downloadAndMaybeDecrypt` check the
  file's mimetype. We didn't pass one, so every image and sticker failed with `InvalidMediaFileType`.
  Fix: pass `mimetype: msg.mimetype`. Verified on the live page by a structural probe (error class/status only):
  every call failed without the argument and succeeded with it.
- **Why the rows stayed "downloading":** reconcile re-queues `failed` media, but `Ingest` enqueued the id *before*
  it set the row back to `pending`. The queue worker reads the row synchronously, saw `failed` and dropped it,
  and the row then stayed `pending` until the next restart. It is now enqueued after the update (regression test
  in `ingest.test.ts`).
- Final failures now log the in-page error class (`download_error:<name>`, no content), so the next WhatsApp
  change shows up in `docker compose logs app` and doesn't fail silently.

## 2026-10-10 — Android 0.2.0: auto-save new photos to the phone

The owner asked for incoming images to be saved to the phone automatically.

- Server: `GET /api/media-feed?after=&limit=` lists messages whose media finished downloading after a cursor (the
  media id, which grows in download order), oldest first. Without `after`, or with a cursor from before a data wipe,
  it returns only the current cursor. Migration 3 adds a partial index on `messages.media_id`. API test included.
- Android: Settings → App → "Save new photos to this phone automatically" (Android 10+, off by default) with
  "Also save videos and GIFs" and "Include status updates". Stickers are never saved. Runs immediately while the app
  is open (media `message_update` events and app start) and through a 15-minute WorkManager job in the background.
  Files go through MediaStore into `Pictures/wa_logger` and `Movies/wa_logger`, so no storage permission is needed.
  The settings text warns that the copies are not encrypted and are visible to the gallery and cloud photo backup.
- Not verified on a device (no emulator here): the WorkManager schedule on Samsung's battery management and the
  MediaStore writes. Unit tests cover the feed client, the selection policy and the cursor; the server endpoint has
  an API test.

## 2026-10-10 — Android 0.3.0: "only disappearing-message chats", emulator, Android 17 local network

- **New option:** auto-save "Only from chats with disappearing messages". WhatsApp's own app never saves media from
  such chats to the gallery, so this saves exactly the photos the owner would otherwise lose. On the live page every
  message carries `ephemeralDuration` (seconds), and it matched the chat setting (probe: 95 flagged messages, all in
  the 14 chats with a timer). The server now stores it (migration 4, `messages.ephemeral_sec`, also backfilled when
  an older row is seen again) and the API exposes `Message.disappearingSec`.
- **Emulator:** the LXC now has KVM. AVD `wal_test` (Android 17, API 37). New on-device tests
  (`app/src/androidTest/AutoSaveDeviceTest`) check the MediaStore writes, the filter and WorkManager scheduling.
  A full adb walkthrough of the release APK against `scripts/dev/autosave-server.mts`: connect, log in, switch
  auto-save on, a live photo arriving (saved in the foreground), and the background job in a process the job started
  itself (forced through `cmd jobscheduler run -f`, with the clock moved 16 min ahead because WorkManager doesn't run
  periodic work early). In both cases only the disappearing photo was saved.
- **Bug found by the emulator:** on Android 17, apps targeting SDK 37 can't connect to private addresses
  (192.168.x.x, 10.0.2.2) without `ACCESS_LOCAL_NETWORK`, which Android shows as "Nearby devices". 0.1.x–0.2.0 show
  "Cannot reach the server" there. The owner's phone is on Android 16, where it works, but it would break with the
  Android 17 update. 0.3.0 declares the permission, asks for it when connecting to a local address, and offers it on
  the "cannot reach" screen (e.g. after a system update).
- Notes: `am kill` counts as a force-stop for WorkManager (it reschedules instead of running). Screenshots are black
  while FLAG_SECURE is on; use `uiautomator dump`.

## 2026-10-10 — Android 0.4.0: select several photos/videos and save them at once

- In a chat, long-pressing a downloaded photo, video or GIF starts selection mode (the header shows "N selected",
  "Select all" and a save button). Taps toggle while selecting, Back cancels. Saving writes everything to the gallery
  (`Pictures/wa_logger`, `Movies/wa_logger`) in chat order and reports the result in a toast. The MediaStore code
  moved from AutoSaver to `MediaOps.saveToGallery` so both features share it.
- "Select all" covers what is loaded in the chat view (scroll up / "Load older" for more).
- Verified on the emulator with the release APK: long-press, add a second photo, save (both files appeared in
  MediaStore), Select all, Back, and a normal tap still opens the viewer. Plus unit tests, a screenshot render of
  selection mode, and the on-device auto-save tests (still passing after the refactor).

## 2026-10-10 — Web: select photos/videos and download them as one ZIP

- Server: `GET /api/media-zip?ids=` (media ids, at most 500, under 4 GB) streams a ZIP. `http/zip.ts` is a small
  writer: stored entries (media is already compressed), CRC and sizes in data descriptors, UTF-8 names, no ZIP64.
  Files are decrypted while streaming and never written to disk unencrypted. The exact Content-Length is computed up
  front so browsers show progress. Entry names: the original file name, or `wa_photo_<UTC date>_<time>.jpg`, made
  unique with " (2)". The API test checks the archive with Python's `zipfile` (an independent reader).
- Web: a download button in the chat header starts selection mode. Rows of downloaded photos/videos/GIFs become
  checkboxes (pointer events inside are off, so nothing opens or plays), with Select all, Esc to cancel, and
  "Download ZIP" (a plain `<a download>`, so the browser streams it to disk).
- Verified in headless Chromium against `scripts/dev/autosave-server.mts` (which now also serves `web/dist`): log in,
  select two photos (no lightbox opened), download. The file passed `unzip -t` and its content was byte-identical
  to the source photo. Esc, Select all, the phone-width layout, and no browser errors.

## 2026-10-16 — media stuck "downloading" again (WhatsApp Web reloaded itself)

- Symptom: photos and videos stayed "downloading" from 2026-10-15 10:00. 7 items were pending with 0 attempts:
  the queue never even tried them. Messages themselves were still logged.
- Cause: at 10:24 WhatsApp Web reloaded its tab (an auto-update to 2.3000.1050452318). whatsapp-web.js re-emitted
  `authenticated`, so the state went to "authenticating". Its next `ready` was ignored, because `onReady` only runs
  once per connection, and the 60 s fallback had the same guard. The state stayed "authenticating". The media queue
  only downloads (and reconcile only runs) in "ready", and dropped the items it picked up meanwhile.
- Fix: `resumeAfterReload` puts the state back to "ready", resumes the queue and re-queues pending media, either on
  the second `ready` or from the fallback after a reload. Both paths have tests that fail on the old code.

## 2026-10-16 — Sending messages (web UI, API; Android client follows)

The owner asked for a "full client": sending as well as logging.

- Server: `wa/walpage.ts` is installed into WhatsApp Web (`Page.addScriptToEvaluateOnNewDocument` + once now, so the
  self-reloads seen on 2026-10-15 keep it) and calls WhatsApp Web's own send functions (read from the module sources of
  2.3000.1050642531 without an account). whatsapp-web.js' `sendMessage` was not used: it builds messages and uploads
  by hand and breaks whenever WhatsApp changes the message shape.
- Media we send is logged before WhatsApp's upload has finished (no `directPath`), so the queue could never download it;
  the sender stores the uploaded bytes for that message id instead.
- Voice notes: Chromium's MediaRecorder writes WebM only, WhatsApp needs Ogg/Opus → `web/src/lib/ogg.ts` remuxes. The
  browser test records with Chromium's fake microphone and decodes the result with `decodeAudioData` (2.6 s, OK).
- Not verified against a real account yet: the send functions were checked in WhatsApp Web's source and against fake
  modules only. The first real send should be watched (`docker compose logs app`, Settings → Security log shows
  `message_sent`).
- Calls were asked for too. They are not part of this change.

## 2026-10-17 — Voice calls (web UI)

The owner asked for calls to make wa_logger a full client, taking the wa2sip project's WhatsApp call bridge as the
model, and explicitly not in wa_logger mobile (Android WebView can't run WhatsApp Web's calling).

- Design: the call runs where WhatsApp Web runs (the Chromium tab); only its audio travels. WhatsApp Web's VoIP code was
  read logged out (2.3000.1050707140, wa2sip's probe image): it takes the microphone from `getUserMedia` and plays
  through Web Audio worklets, so `wa/callpage.ts` gives it a virtual microphone (a MediaStreamDestination the app feeds)
  and taps every node connected to an output. wa2sip used PulseAudio devices instead; here that would have meant sound
  servers and a new audio port in the Chromium container, while the hooks need nothing but the page.
- Control code is wa2sip's (`startWAWebVoipCall`, the VoIP stack's `acceptCall`/`rejectCall`/`endCall`, a 250 ms poll of
  `WAWebCallCollection`). Neither project has placed a real call yet.
- Found while testing in the real Chromium image: `Runtime.bindingCalled` only arrives with `Runtime.enable`; two tapped
  contexts interleaved their samples (fixed: one sending tap at a time, silence not sent); WhatsApp Web moves accepted
  video calls into a popout window and uses document PiP when available, whose `getUserMedia`/Web Audio are that
  window's own (fixed: hook `window.open` results, delete `documentPictureInPicture`); a CDP click hangs while the tab is
  hidden behind a popout (fixed: 3 s timeout, then `page.evaluate`); a never-clicked popout keeps its audio suspended
  (fixed: `--autoplay-policy=no-user-gesture-required` in the Chromium entrypoint).
- Verified: `scripts/dev/call-audio.mts` in the real image (440 Hz in → 440 Hz heard by the fake WhatsApp graph, 1 kHz out
  → 1000 Hz at the app, in the tab and in a popout, both output routes), `scripts/dev/call-ui.mts` in a browser with a
  fake microphone (24 steps), unit tests for the page code (vm), the API/WebSocket/state machine and the browser worklet.
- Read-only check of the owner's instance: `enable_web_calling` true, page cross-origin isolated, all call modules
  present, microphone `denied` / 0 inputs before the hooks (expected).
- Not verified: a real WhatsApp call. The first one should be watched (`docker compose logs app` shows `call` /
  `call ended` with direction, reason and duration; Settings → Security log shows `call_started` / `call_accepted`).
- Also fixed: `scripts/smoke.sh` failed on the dev host because Chromium's CDP/VNC relays listened on the egress network.
  The host's DNS search domain resolves the bare name `app` to a public address, and Chromium starts before the app
  container exists, so `resolve_bind_ip` took the route to that address. It now only accepts an on-link route. The same
  could happen on any host whose resolver answers for `app`. Smoke test: 23/23 again.

## 2026-10-17 — Android client 0.6.0: calls

- The native client (not wa_logger mobile) talks to the server, so it can carry calls over the same audio WebSocket:
  `CallAudioSocket` + `JitterBuffer` in core (unit-tested with MockWebServer), `CallAudioEngine` (AudioRecord in
  voice-communication mode → 16 kHz frames, AudioTrack for the other side), `CallController` (the web CallProvider's
  logic), a foreground service of type microphone while a call goes on, the call panel and a call button.
- Emulator walkthrough (Android 17, adb + uiautomator, `QEMU_AUDIO_DRV=none` for a silent virtual microphone) against
  `scripts/dev/call-ui.mts` in serve mode: outgoing call connected with the microphone stream arriving (≈32 kB/s),
  mute stops it, backgrounding keeps it (service type 0x80, audio mode IN_COMMUNICATION), Hang up from the
  notification ends it and restores the audio mode, incoming call answered then ended by the other side ("Call ended ·
  0:05"), decline. connectedDebugAndroidTest still passes.
- Not verified: sound quality and echo on a real phone, and a real WhatsApp call.


## 2026-10-17 — Video calls (web UI)

- Read WhatsApp Web's video code logged out (2.3000.1050712378). The wasm stack hands every frame to
  `videoRendererRegistry.onVideoFrameWasmToJs(...)`; with WebCodecs available (H.264 encode+decode, which the container's
  Chromium has) the peer's frames arrive there still H.264-compressed. That is the tap: frames are passed through
  without transcoding. The camera side reuses what WhatsApp's own test driver does: a canvas capture stream.
- Transport: a separate `WS /api/calls/video` (so the audio socket and the Android 0.6.0 client are unchanged), one
  frame per message with a 12-byte header. Browsers encode VP8 (H.264 where they can't), WhatsApp's side stays H.264.
- Found by the tests: `Permissions-Policy` had `camera=()`, which blocks `getUserMedia({video})` even on our own page
  (now `camera=(self)`); a `<video>` in a hidden tab never started playing, and WhatsApp moves video calls into a popout
  window that hides its tab, so the Chromium container now runs without background throttling.
- Verified: vm/API tests, `call-video.mts` in the real image (H.264 out decodes red, VP8 in shows blue and rotated),
  `call-ui.mts` 39 steps with Chromium's fake camera. Not verified: a real video call (same as audio).

## 2026-10-17 — Android client 0.7.0: video calls

- Camera2 (front camera) → MediaCodec H.264 encoder through its input surface; frames keep the sensor orientation and the
  header carries the rotation. The other side's H.264/VP8 → MediaCodec decoder → TextureView, fitted and turned upright
  with `setTransform`.
- Found on the emulator: the goldfish hardware H.264 decoder fails on its first input (an SELinux-denied buffer pool),
  so a decoder that fails is now skipped for the next one (Android's software decoder works); the TextureView transform
  must be re-applied on layout (it was set before the view had a size: a stretched picture); minimizing and restoring
  rebuilt the camera session twice and the failure callback of the stale one switched the camera off.
- Verified on the emulator: picture fitted and upright, the phone's frames upright after their rotation (saved and
  compared with the preview), camera off/on, background with the camera+microphone service, incoming video answered.



## 2026-10-20 — Android client 0.8.0: servers behind authentik

- The owner put the server behind authentik forward auth on Nginx Proxy Manager. The client now detects authentik's
  sign-in redirect, logs in with OAuth 2 + PKCE in a Custom Tab against a public client (`walogger-android`), stores the
  refresh token Keystore-encrypted and sends a bearer token the outpost checks by introspection (`core/Authentik.kt`,
  same file in insta_logger, web-ip-phone and RWR). Setup and design: `docs/authentik.md`.
- Learned: authentik 2026.8's outpost (now Rust) checks `Authorization: Bearer` with token introspection, which accepts a
  token of provider A for proxy provider B only if **A lists B** in `jwt_federation_providers`. The proxy's Basic auth
  path with the account password is refused (only app passwords work there).
- Verified: `AuthentikTest` (7, fake proxy/outpost/authentik), and on the emulator against a real authentik + NPM:
  detection, Custom Tab login, redirect back, wa_logger's login reached through authentik, restart keeps the sign-in,
  revoking the tokens in authentik brings the sign-in screen back.


## 2026-10-20 — Multi-user support (gateway, workers, per-user browsers)

- Request: first account = admin, admin creates users (temporary password, forced change at first sign-in), a separate WhatsApp
  Web per account (own QR), strong isolation so one compromised account can't reach others, a user-management page, and
  per-user ports (the admin behind authentik, a friend on another domain without it).
- Design (ARCHITECTURE §3, §6): the former app became the per-user **worker** (own unix user, SQLite, keys) behind a
  **gateway** that is the only listener and routes by tenant cookie; a root **supervisor** starts them; the chromium container
  runs a Go **manager** with one Xvfb + Chromium + x11vnc per user, reachable only with per-instance tokens. Tenant 1 keeps the
  single-user layout so upgrades adopt the existing account as the admin. Alternatives rejected: one process with per-request
  tenant contexts (no isolation against app bugs), one container per user (needs a Docker-socket orchestrator).
- Found while testing on real containers (all fixed, all in AGENTS.md "Gotchas"): the manager started before the app existed
  and blocked the app's start through the healthcheck; root (no DAC override) can't write into, chmod or delete inside a
  directory it handed to a tenant — do it as the tenant (also `rm` of stale locks, `find -delete`); `kill` needs `CAP_KILL`;
  Node needs `HOME` for a uid without a passwd entry; the supervisor must join the front's group to probe sockets;
  a recreated container (new hostname) leaves Chromium's `SingletonLock` pointing at "another computer" — found by the
  upgrade test (old images + seeded volumes → new compose), which also showed the existing owner adopted as admin with the
  data readable.
- Security review items fixed before release: the gateway's token alone would have opened `/internal/*` for any path a client
  could get forwarded (now: `X-WAL-Scope` the gateway never forwards, strict `/api/…` path check, all client `X-WAL-*` stripped);
  worker Node heap cap; origin per port overrides forwarded scheme/host.
- Verified: server 189 tests, Go tests, `multiuser-e2e.mts` on compose (three unix users for workers and browsers,
  no capabilities in gateway/workers, sandbox on, cross-user file access denied, delete removes data/browser/processes),
  Playwright walkthrough (create user → claim → own QR + live view), upgrade from the old layout.
- Also green: `scripts/smoke.sh` 30/30 (source and `--deploy` layouts), the existing 61-step UI walkthrough (`e2e-ui.mjs`) against a
  seeded multi-user stack (every message/media/search/settings route now goes through the gateway), Playwright screenshots of
  the new screens, Android `:core:test` + `:app:compileDebugKotlin` (the login hint for temporary passwords).
- One flake seen once: a worker's first WhatsApp Web load failed with "Cannot read properties of null (reading 'info')"
  and kept failing for ~90 s while two others worked; it did not recur in 5 later runs (stack frames are now logged on
  "whatsapp connect failed"). Watch for it.

## 2026-10-20 (later) — Android: multi-user parity (0.9.0, not released)
- The multi-user work had left the app with only a login hint. Ported: the choose-your-own-password step (`LoginStep.Claim`,
  with the recovery key after an admin reset → `ApiClient.claim`) and the admin *Users* tab (users with status/WhatsApp
  state/port, add, enable/disable, reset, delete with password+2FA re-auth, ports, admin log). The tab only exists when
  `AppState.role == admin`; on phones the rail items now share the bar width (7 items).
- The server needs explicit JSON `null` for "default port" / "no fixed origin" (`WaJson` omits nulls), so the admin calls
  build their bodies with `buildJsonObject`; `ApiClientTest` pins the exact bodies.
- New rule in CLAUDE.md: every web UI change is ported to the Android client in the same work.
- Checked: `:core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`, Roborazzi render of the Users page.
  Not yet checked against a live multi-user stack or on the emulator.

## 2026-10-21 — Call recording (server, web, Android 0.10.0)
- Request: record bridged calls automatically or with a button, also video calls. Built as `wa/recorder.ts` + `wa/recfmt.ts`:
  a wall-clock `AudioMixer` (peer + own voice, silence filled), IVF-framed H.264 from the page's video tap, ffmpeg → fragmented
  MP4 → `MediaFileWriter` (encrypted). Settings `recordCalls` (off by default), `POST /api/calls/:id/recording`,
  `GET/DELETE /api/call-recordings`, SSE `call_recording`, REC sign in `CallInfo.recording`.
- Design decisions: (1) the app only holds the owner's *public* key, so a "capture now, convert later" design could not read its own
  capture without a login; ffmpeg therefore runs live and its output is encrypted on the fly. (2) ffmpeg blocks while probing an
  input without data, so in video calls it is started at the first peer key frame (audio is buffered meanwhile; `fps start_time=0`
  pads the picture to the start). (3) An overlay-on-black design was dropped (framesync waits for both inputs); black frames are
  fed instead while the other camera is off. (4) Only the other side's picture is recorded; VP8 is skipped.
- Removed the old "never record" rules from CLAUDE.md in favour of the explicit-consent rules; the Dockerfile now installs ffmpeg.
- Tests: `recfmt.test.ts`, `recording.test.ts` (real ffmpeg), web build, Android `ApiClientTest` + screenshot renders.

## 2026-10-21 — Blocked contacts (server, web, Android 0.11.0)
- Request: the admin picks, per user, contacts that are not logged (messages kept out of the database, so a deleted message leaves
  nothing) and whose calls cannot be recorded; selection by phone number so renaming the contact changes nothing.
- Design: worker-side `BlockList` (+ migration 7 `blocked_contacts`, `contact_directory`); checks in `Ingest` (message, edit, revoke,
  reaction, ack, sync passes) and `CallService.startRecording`; admin routes relay through the gateway. Names are encrypted for the
  user only, so the admin's pick list needs a separate directory — the owner chose "names + numbers" over numbers only; labels are
  sealed with a per-user key file (documented exception in ARCHITECTURE "Blocked contacts").
- Decisions: groups — a blocked sender's messages are skipped too; unresolvable LIDs fail closed (5 min retry); old data stays;
  group calls are not covered; blocking mid-call stops the running recording.
- Tests: `wa/blocklist.test.ts` (8; mutation-checked), gateway admin route test, Android `ApiClientTest`.

## 2026-10-26 — API tokens for other apps (server, gateway, web)
- Request: Poker Balance (separate app) should post game results to a WhatsApp group or DMs through wa_logger. wa_logger had only
  cookie sessions + CSRF + Origin, so nothing but a browser could send.
- Design: per-user bearer tokens limited to a chat allowlist, send-text + list-destinations only (no reading). Chat names are sealed to
  the owner, so the names a token shows are copied sealed (`apitoken.key`) at creation, as in the block list's directory. The owner
  chose scope "send + chat list" implicitly by asking only for sending; "receive" was not built (it would need message access).
- Tests: `api/tokens.test.ts` (5), gateway routing test; migration 8. Not ported to Android (noted in AGENTS.md).


## 2026-10-26 — API-only TLS port for other apps
- Problem: production runs `Caddyfile.http` behind NPM/authentik, so the only LAN ports speak plain HTTP and 443 is localhost-only;
  Poker Balance (HTTPS-only for its token) got "refused the request" (a redirect/HTTP answer) from the LAN address.
- Fix: optional `API_TLS_PORT` listener (`caddy/extra-ports.sh`, `wal_api` snippet in both Caddyfiles): `/api/v1/*` only, pinned
  self-signed cert in `/data/api-tls`, `default_sni` added to `Caddyfile.http` for IP clients. Chosen by the owner over exposing 443
  or allowing plain HTTP. Tested with the built image against a stub app (200 on /api/v1, 404 elsewhere, fingerprint = logged one).
