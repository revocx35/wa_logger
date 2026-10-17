# wa_logger — Architecture

> Source of truth for design decisions. Read this (and `progress.md`) before changing anything.
> If you change a decision, update this file in the same commit.

## 1. What it is

A self-hosted, single-owner, Docker-based **WhatsApp message logger**. A real Chromium runs
WhatsApp Web in a background container. The app watches WhatsApp Web through the Chrome
DevTools Protocol (via `whatsapp-web.js`) and records **every message, edit, reaction and media file**
the owner's account sends or receives, encrypted at rest. When someone deletes a message
("deleted for everyone"), the logged copy stays viewable and is flagged as deleted.

The web UI looks like WhatsApp: chat list, chat view, media. Since 2026-10 it can also **send** as the linked account
(text, replies, media, files, voice notes, reactions, edits, delete for everyone, new chats; §4 "Sending") and make and
take **voice calls** from the browser (§4 "Calls").
The live Chromium screen can be opened from the menu ("WA Web") through an in-browser VNC client.

Out of scope on purpose: video (calls are voice only), call recording, multiple WhatsApp accounts or tenants, and
**view-once media** (it is logged only as a placeholder and never downloaded).

## 2. User flow

1. **Signup** (`/signup`). Only possible while no owner account exists. It needs the
   `SETUP_TOKEN` from `.env`, so a stranger who reaches the page first cannot claim the instance.
   Fields: setup token, username, password (min 12 characters), confirm.
2. **Recovery key** (`/setup/recovery`). Shown once. It is the only way to recover the data if the
   password is lost (see §6). The user must tick "I saved it".
3. **Link WhatsApp** (`/setup/link`). Shows the live Chromium screen (noVNC) with WhatsApp Web's QR code
   and a status pill (`starting → qr → authenticating → syncing/ready`). The user scans the QR code with
   their phone. The **Complete** button is enabled once the WA state is `ready`.
   Clicking it marks onboarding done and forwards to `/`.
4. **Main** (`/`). A WhatsApp-like two-pane UI: chat list on the left, chat on the right, and a menu rail with
   **Chats**, **Deleted**, **WA Web**, **Settings** and **Logout**.
5. Later visits: go to `/login` (or `/signup` if no owner exists), then `/`
   (or `/setup/link` if onboarding is not complete).

## 3. Containers & networks

```
                internet
                   │
          ┌────────┴────────┐   network: public (bridge)      ports 80/443 published
          │      caddy      │   TLS termination (ACME or internal CA), HTTP→HTTPS
          └────────┬────────┘
                   │ network: edge (internal: true)
          ┌────────┴────────┐
          │       app       │   Node 24 · Fastify · whatsapp-web.js · SQLite · serves built web UI
          │  (no internet)  │   volume app_data:/data  (db + encrypted media)
          └────────┬────────┘
                   │ network: backend (internal: true)
                   │   tcp 9223 → CDP (socat → 127.0.0.1:9222)   tcp 5900 → x11vnc
          ┌────────┴────────┐
          │    chromium     │   Debian trixie · Chromium (headful, sandbox ON via seccomp profile)
          │                 │   Xvfb :99 · x11vnc · socat · volume chromium_profile:/data
          └────────┬────────┘
                   │ network: egress (bridge) → web.whatsapp.com / WA CDNs
                internet
```

* Two compose files: `docker-compose.yml` builds all three images from source (`Dockerfile`, `chromium/`, `caddy/`),
  and `deploy/docker-compose.yml` uses the images CI publishes to GHCR (`ghcr.io/revocx35/wa_logger-{app,chromium,caddy}`).
  The standalone variant only needs `seccomp-chromium.json` and `.env` next to it. The Caddyfile is baked into the
  caddy image so Caddy keeps a read-only root filesystem (compose `configs.content` cannot be used with `read_only`).
* HTTP mode (`CADDY_CONFIG=Caddyfile.http`, `setup.sh --http-only`): Caddy serves plain HTTP behind the user's own
  TLS reverse proxy and trusts X-Forwarded-* from private ranges. The app uses `TRUST_PROXY=2` and
  `COOKIE_SECURE=auto`: `Secure`/`__Host-` cookies and HSTS whenever the request arrived over HTTPS.
  * Client IP (used by the login throttle): Nginx Proxy Manager *appends* the address it saw to the client's
    `X-Forwarded-For` (`$proxy_add_x_forwarded_for`), and Caddy, trusting NPM's private address, appends NPM's. The
    app trusts exactly `TRUST_PROXY` hops from the right (Caddy's socket + NPM's entry), so the client IP is the
    entry NPM appended, and anything a client puts in front of it is ignored.
  * The hop count must match reality. Too low (`1` behind NPM): every client looks like NPM, and 5 failures lock the
    per-IP throttle for everyone coming through it. Too high: clients can pick their own IP. Another proxy in front of
    NPM (e.g. Cloudflare) makes it `3`.
  * Caddy trusts any private address, so a LAN host that reaches port 80 directly can claim any client IP and get
    around the per-IP limit (the global limit still applies). That's why port 80 in HTTP mode should be reachable only
    from the proxy.
* Only **caddy** publishes ports. The **app** has no route to the internet (it sits only on internal networks).
  **chromium** is the only component that talks to WhatsApp.
* CDP has no authentication, so it is reachable only on `backend`, where the app is the only other container.
  Chromium ignores `--remote-debugging-address` in headful mode, so it listens on 127.0.0.1:9222 and
  `socat` exposes it as `0.0.0.0:9223` inside the container.
* Chrome rejects CDP HTTP requests whose `Host` header is not an IP or `localhost`. The app therefore
  **resolves `CHROMIUM_HOST` to an IP** (`dns.lookup`) and connects to `http://<ip>:9223`.
* x11vnc is protected by `VNC_PASSWORD` (defense in depth). Its port is reachable only on `backend`, and the
  browser reaches it **only** through the app's authenticated WebSocket bridge `/api/vnc`.
* Hardening on every container: `no-new-privileges`, `cap_drop: [ALL]` (caddy re-adds `NET_BIND_SERVICE`),
  non-root users, `read_only` root filesystems with explicit tmpfs mounts, memory limits, healthchecks.
* Chromium keeps its **sandbox enabled**. Docker's default seccomp profile blocks the user-namespace syscalls
  the sandbox needs, so `chromium/seccomp-chromium.json` (Docker's default profile plus `clone`, `clone3`,
  `unshare`, `setns`, `chroot` and similar) is applied. **Never ship `--no-sandbox`.** It is available only as an
  explicit escape hatch (`CHROMIUM_NO_SANDBOX=1`) with a startup warning.

### chromium container
* `entrypoint.sh` acts as a small supervisor (bash `wait -n` plus restart loops). It removes stale
  `Singleton*` locks, then starts `Xvfb :99 -screen 0 ${SCREEN}`,
  `chromium --user-data-dir=/data/profile --remote-debugging-port=9222 --kiosk --no-first-run
  --no-default-browser-check --password-store=basic --disable-features=Translate,MediaRouter
  --noerrdialogs --hide-crash-restore-bubble --autoplay-policy=no-user-gesture-required --window-position=0,0
  --window-size=W,H about:blank` (the autoplay flag lets WhatsApp Web's call audio run without a human click, also in
  a call popout window; there are no sound devices, the audio only goes to the app, §4 "Calls"),
  `x11vnc -display :99 -rfbport 5900 -rfbauth … -forever -shared`, and
  `socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222`. Crashed children are restarted.
* socat and x11vnc listen only on the container's address in the network shared with the app (`BACKEND_PEER`): the
  entrypoint resolves `app` and takes the source address of the route to it, and accepts it only if that route is
  on-link (no gateway). Before the app container exists, Docker's DNS forwards the name to the host's resolver, where a
  search domain can turn `app` into some public address; without the check the relays would listen on the egress
  network and the app could not reach them (seen on the dev host, 2026-10-17).
* The healthcheck calls `curl -fs http://127.0.0.1:9222/json/version`.
* The profile volume **contains the live WhatsApp session**. Anyone with it can impersonate the account.

## 4. App (server) — `server/`

Node 24 LTS, TypeScript (ESM), Fastify 5, better-sqlite3 (WAL), zod for validation, and whatsapp-web.js
(pinned; puppeteer download skipped). Tests use vitest.

```
server/src/
  index.ts            bootstrap: config → db → crypto keyring → http → wa (only once an owner exists)
  config.ts           zod-parsed env (see §9); fails fast on bad config
  log.ts              pino with redaction (cookies, auth headers, passwords, tokens, message bodies)
  db/                 connection, migrations (schema in §7), repositories (typed, prepared statements)
  crypto/
    primitives.ts     AES-256-GCM, HKDF-SHA256, X25519 ECDH, scrypt, random, constant-time compare
    password.ts       scrypt-derived auth hash + KEK (§6)
    keyring.ts        owner keypair, DEK lifecycle, ECIES seal, field encryption with AAD binding, DataReader/Writer
    stream.ts         chunked AEAD file format for media, range-decrypt
  auth/               routes (signup, login, logout, recovery, TOTP, password), sessions (cookie, CSRF token),
                      throttle.ts (race-free per-IP + global brute-force throttle), totp.ts
  http/               server factory, security headers/CSP, static web UI, error handler
  api/                chats, messages, media (Range), search, deleted feed, SSE events, settings, audit, data wipe
  vnc/                authenticated WebSocket ↔ TCP bridge to chromium:5900
  wa/
    pageapi.ts        direct reads from WhatsApp Web's models: chats, contacts (LID → phone), history, avatars
    browser.ts        resolve host → IP, connect puppeteer to CDP, tab hygiene (close stale WA tabs)
    client.ts         whatsapp-web.js Client lifecycle, state machine, reconnect with backoff
    ingest.ts         event handlers → mapper → repositories (idempotent upserts)
    mapper.ts         serialized WA message → DB record (pure, unit-tested); msgKey() rebuilds message keys
    media.ts          priority download queue (live > history), size cap, timeouts, retries, disk guard, encryption
    sync.ts           initial history import + periodic reconcile (catches missed/revoked msgs)
    avatars.ts        best-effort profile pictures (fetched inside the browser page, never by the app)
    walpage.ts        code installed into WhatsApp Web as window.__wal: sending through WhatsApp Web's own send actions
    walbridge.ts      WalPage: injects walpage.ts (now + at every document start, so self-reloads keep it), runs its ops
    sender.ts         Sender: send API used by api/send.ts (chunked uploads into the page, hourly cap, stores sent media)
    callpage.ts       code installed into WhatsApp Web as window.__walcall: call monitor and controls, virtual microphone,
                      speaker tap (§4 "Calls")
    callbridge.ts     CallBridge: injects callpage.ts, CDP bindings for call events + audio, 40 ms audio pump, trusted click
    calls.ts          CallService: call state machine, audio bridging to one client, hourly cap (used by api/calls.ts)
  testutil/           harness (in-process app + cookie-jar client), seed.ts (dev sample data) — not in the build
shared/api.d.ts       API DTO types shared by server and web (type-only)
```

### WhatsApp integration rules
* Create the `Client` with `puppeteer: { browserURL: 'http://<ip>:9223', defaultViewport: null }`,
  `authStrategy: NoAuth` (the session lives in the Chromium profile volume),
  `webVersionCache: { type: 'none' }` (the container filesystem is read-only), and `takeoverOnConflict: true`.
* **Never call `client.destroy()`.** On a connected browser it would close the remote Chromium. On shutdown,
  `browser.disconnect()`. Before initialize, close leftover `web.whatsapp.com` tabs. After initialize,
  close stray `about:blank` tabs and `bringToFront()` the WA tab, so VNC shows it and there is only one WA tab.
* A crashed or closed WhatsApp tab (`page` `error`/`close`), a lost CDP connection, or a page that stops answering
  a 60 s watchdog probe twice triggers a reconnect with backoff. Reconcile then catches up on missed messages.
* **Do not use whatsapp-web.js chat helpers** (`getChats`, `getChatById`, `getProfilePicUrl`, `Chat.fetchMessages`):
  on current WhatsApp Web builds they go through `WWebJS.getChatModel`, which throws for ~90% of chats (and
  `getChats` fails as a whole). `wa/pageapi.ts` reads the same data directly from WhatsApp Web's models with
  per-chat error isolation. Events and `WWebJS.getMessageModel` (message serialization) are still used.
* **Message keys:** WhatsApp Web's MsgKey no longer serializes `_serialized`. `mapper.ts#msgKey()` rebuilds
  `<fromMe>_<remote>_<id>[_<participant>][_<self>]` (own messages end in `_out`), identical to
  `MsgKey.toString()`. Messages without a buildable key are skipped. Everything (media lookups via `Msg.get`,
  quotes, reactions, revokes) depends on this key being right.
* **LID ids:** one-to-one chats and group participants use `…@lid` ids (no phone number). The phone number
  comes from `contact.phoneNumber` or `WAWebLidMigrationUtils.toPn()` and is stored encrypted (`contacts.phone_enc`)
  as the last name fallback (saved name → `~pushname` → phone).
* Start the WA client only once an owner exists, because the owner's public key is required to encrypt anything.
* Events used: `qr`, `loading_screen`, `authenticated`, `auth_failure`, `ready`, `change_state`,
  `disconnected`, `message_create` (fires for incoming **and** outgoing messages, so it is the single source for new
  messages), `message_ciphertext`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`,
  `message_reaction`, `message_ack`, `chat_removed`, `chat_archived`, `group_join`, `group_leave`,
  `group_update`, `contact_changed`. All handlers are idempotent upserts keyed by the serialized message ID.
* **Media is downloaded immediately** on `message_create`, because after a revoke it can no longer be
  fetched. The queue runs at concurrency 2 (live before history), up to 4 attempts with backoff
  5 s/30 s/2 min/10 min. The download happens inside the page (same internals as whatsapp-web.js) and is pulled
  over CDP in 2 MiB slices that are encrypted straight to disk. Every WhatsApp call is raced against a timer
  (20 s poke, 120 s download, 180 s overall), because `downloadMedia()` can hang forever.
  Media larger than `MEDIA_MAX_MB` is `too_large`. History media whose CDN copy expired (stage `NEED_POKE`
  after a download attempt, observed for media older than about 2–4 weeks) becomes `unavailable` after 2 tries.
  Downloads pause while the data filesystem has less than 2 GB free. Failed, too-large, skipped or unavailable
  media can be retried from the UI.
* **View-once** (`isViewOnce` or a view-once wrapper type) → stored with `media_status='view_once'`. No download,
  no thumbnail. The UI shows a "View-once media is not logged" placeholder.
* Revoke: `message_revoke_everyone(after, before)` → mark the original row `deleted_at=now`, `deleted_by`.
  If the original was never logged and `before` is present, insert it first.
  If both are missing, insert a stub row flagged deleted with `body=null`.
* Edit: `message_edit(msg, newBody, prevBody)` → push `prevBody` into `message_edits` (dedupe), set
  `body=newBody` and `edited_at`.
* History: after the first `ready` (until `app_state.initial_sync_done` is set), fetch each chat's last
  `HISTORY_PER_CHAT` messages (default 200, via `pageapi.fetchMessages`) and upsert them with `source='history'`.
  History media is queued at low priority, depending on the setting. Deleting `initial_sync_done` re-imports.
* Reconcile every `RECONCILE_MINUTES` (default 10) and on every `ready`: re-fetch recent messages of chats
  whose `timestamp` moved, upsert them, and mark as deleted any message whose type has become `revoked`.
  This catches events missed while the app was down.
* Status updates (`status@broadcast`) are logged when setting `log_status=true` (default) and appear as a
  special "Status updates" chat.

### Sending
* `api/send.ts` → `ctx.wa.sender` (`wa/sender.ts`) → `WalPage.call(op)` → `window.__wal.call(op)` in the page
  (`wa/walpage.ts`). The page code only calls WhatsApp Web's own actions, the ones its compose box and message menu
  use: `WAWebSendTextMsgChatAction.sendTextMsgToChat(chat, text, {quotedMsg})`;
  `WAWebMediaOpaqueData.createFromData(file, mime)` → `WAWebPrepRawMedia.prepRawMedia(opaque, {asDocument|isPtt|asGif,
  precomputedFields})` → `MediaPrep.sendToChat({chat, options: {caption, quotedMsg}})` (WhatsApp uploads, then sends);
  `WAWebSendReactionMsgAction.sendReactionToMsg(msg, emoji)`; `WAWebCmd.Cmd.sendRevokeMsgs(chat, {list, type:'message'},
  {clearMedia:true})` after `WAWebMsgActionCapability.canSenderRevokeMsg`; `WAWebSendMessageEditAction.sendMessageEdit`
  after `canEditText`; `WAWebUpdateUnreadChatAction.sendSeen({chat})`; `WAWebQueryExistsJob.queryPhoneExists('+…')`.
  Results with `messageSendResult !== 'OK'` become `send_failed` errors.
* walpage.ts is self-contained source text (`WAL_PAGE_SOURCE`) and runs without Node globals; `walpage.test.ts` runs
  that exact string in a `vm` context against fake WhatsApp modules.
* Files: `POST /api/uploads` (raw `application/octet-stream` body, the only non-JSON route; 64 MB, 4 pending, 10 min,
  session-bound, memory only) → `POST /api/chats/:chatId/send-media {uploadId, kind}`. The sender pushes the file into
  the page in 1 MiB base64 chunks. WhatsApp adds the message to the chat **before** the upload finishes, so ingest
  logs it without a downloadable file; `Sender.storeSentMedia` then stores the uploaded bytes for that message id
  (encrypted like any media), and the media queue drops its own download if a file appeared meanwhile.
* Voice notes must be Ogg/Opus. Firefox records that; Chromium only records WebM/Opus, which `web/src/lib/ogg.ts`
  remuxes to Ogg (same Opus packets). The page computes the duration and the 64-bar waveform before sending.
* Sent messages come back through `message_create` and are logged like everything else. Sending a message (not a
  reaction) marks the chat as read; opening a chat does so only with the `readReceipts` setting.
* Limits: route rate limits plus 300 sends/hour (`Sender.charge`), audited as `message_sent` (type only).

### Calls
WhatsApp Web has had calling since July 2026 (it needs a cross-origin isolated page, which our Chromium has). The owner's
browser is not where WhatsApp Web runs, so the call runs in the Chromium tab and only its **audio** is carried over:

```
owner's browser                      app                                Chromium tab (WhatsApp Web)
mic → AudioWorklet (16 kHz s16le) ─► WS /api/calls/audio ─► CallBridge ─► Runtime.evaluate __walcall.audioIn (40 ms)
                                                                          → virtual microphone (MediaStreamDestination)
                                                                          → getUserMedia → WhatsApp's capture worklet
speakers ◄─ AudioWorklet ◄──────── WS ◄──────────────── binding __walCallAudio ◄─ speaker tap (ScriptProcessor, 16 kHz)
                                                                          ◄─ WhatsApp's playback worklet → output
```
* **Control** (`wa/callpage.ts`, adapted from the wa2sip project's `agent/page.js`): a 250 ms poll of
  `WAWebCallCollection` reports every state change through the CDP binding `__walCallEvent` (ids and states, no names).
  Start: `WAWebVoipStartCall.startWAWebVoipCall(wid, false, CALL_FROM_UI.CONVERSATION, 0, null, {entryTrust:
  'user_gesture'})`. Answer: `WAWebCallRingtone.stopCallRingtone()`, `WAWebVoipAcquireMediaStream.checkVoipDevicePermissions`,
  `(await WAWebVoipStackInterface.getVoipStackInterface()).acceptCall(true, false)` (audio only). Decline: `rejectCall()`.
  Hang up: `endCall(EndCallReason.Self, true)`. These are the functions WhatsApp Web's own call buttons use.
* **User activation:** start and answer run inside a trusted CDP mouse click on a 6×6 px transparent button the page
  code adds, like a real click on WhatsApp's buttons. While the tab is hidden (behind a call popout) the click never
  completes, so after 3 s the operation runs from `page.evaluate` instead. Chromium also runs with
  `--autoplay-policy=no-user-gesture-required`.
* **Audio in the page:** WhatsApp Web takes the microphone from `getUserMedia` and plays the other side through Web
  Audio (a worklet connected to `AudioContext.destination`, or to a `MediaStreamDestination` played by an `<audio>`).
  `callpage.ts` hooks, at document start: `getUserMedia` (audio-only requests get a clone of the virtual microphone's
  track; requests with video are untouched), `enumerateDevices` (the virtual microphone is the only audio input),
  `permissions.query({name:'microphone'})` → granted (the browser itself keeps no microphone access: managed policy
  `AudioCaptureAllowed: false`, and there is no device), and `AudioNode.prototype.connect`: any node connected to an
  output is also connected to a per-context ScriptProcessor that decimates to 16 kHz. Only one tap sends at a time
  (the one that last carried sound), digital silence is not sent. Windows WhatsApp Web opens (`window.open`, the call
  popout it uses automatically for video calls) get the same hooks; `documentPictureInPicture` is removed so the call
  UI never moves into a PiP window.
* **Bridging:** audio crosses only while `setBridge(true)`: the call is ours (outgoing being placed, or connecting/active)
  **and** a client is attached. One audio client at a time; a new connection replaces the old one (close 4000), the
  socket closes with the call (1000). Frames: binary 16 kHz mono s16le, even length, ≤ 6400 bytes, ≤ 96 kB/s per client
  (3× real time, else 1008); towards the page at most 0.5 s is queued, towards a slow client ≥ 64 kB buffered is dropped.
  The browser's worklet keeps a 60 ms prebuffer and drops backlog above 300 ms.
* **State** (`wa/calls.ts`): WhatsApp's `CallState` → `incoming | calling | ringing | connecting | active | ended` (table in
  docs/wwebjs-notes.md "Calls"); end reasons from `callLogResult`, `peerBusy`, `wasEverConnected`, `userEndedCall`.
  A call first seen in a terminal state is ignored. The chat shown is the one we log (the call's LID or its phone-number
  id). SSE `call` events carry ids/states; `GET /api/calls/current` adds the decrypted name.
* Not stored: call audio is never written anywhere or logged. WhatsApp's own call-log messages are logged as before.
  Audit: `call_started`, `call_accepted`, `call_declined` (no ids). Cap: 30 started calls per hour on top of route limits.
* Clients: the web UI and the Android client (§12 "Calls", same WebSocket and PCM format). wa_logger mobile can't have
  them (Android WebView pages are never cross-origin isolated, see docs/wwebjs-notes.md).

## 5. Web UI — `web/`

React 19 + Vite + TypeScript SPA, built into `server` static assets. No CDN, no external fonts, and no inline
scripts, so it satisfies a strict CSP. `@novnc/novnc` provides the VNC client, and `qrcode` renders the TOTP enrollment QR code.

Routes: `/signup`, `/login`, `/recover`, `/setup/recovery`, `/setup/link`, `/` (chats), `/chat/:chatId`,
`/deleted`, `/wa-web`, `/settings`. A route guard uses `GET /api/state` to decide where the user belongs.

Chat view features: date separators; sender names (colored) in groups; the WA text formatting parser
(`*bold*`, `_italic_`, `~strike~`, `` ```mono``` ``, `> quote`, lists, links) renders to React elements, **never HTML**;
quoted replies (click to jump); forwarded label; edited badge with an edit-history popover;
deleted badge (red, "Deleted for everyone · logged copy") while still showing the content; reactions; ticks for
own messages; image lightbox; `<video>`/`<audio>` players (Range-served); documents download as attachments;
stickers; location cards (coordinates plus an OpenStreetMap link, no embedded map); vCards; polls; call logs and
system messages as centered pills; a view-once placeholder; select photos/videos (header download button, click
rows, Select all, Esc) and download them as one ZIP; infinite scroll upward; live updates via SSE;
per-chat and global search. Layout is responsive (single pane under 900px). Light and dark themes follow the system.

Calls (`components/Calls.tsx`, `lib/callAudio.ts`, `lib/call-worklet.js`): a `CallProvider` around the main layout
follows the current call (SSE `call` + `GET /api/calls/current`) and shows a floating call panel (incoming: Answer /
Decline with a Web Audio ringtone and the tab title; outgoing: Calling… / Ringing… with a ringback; active: timer, mute,
hang up; ended: the reason for 4 s; "Join audio" / "Move audio here" when the call has no audio in this tab, e.g. after
a reload). The phone button in one-to-one chat headers starts a call. `CallAudio` is created inside the click (browsers
start audio only after a gesture): `getUserMedia` with echo cancellation/noise suppression/AGC, an AudioWorklet (plain JS
module emitted by Vite as a hashed same-origin asset, so `script-src 'self'` covers it) that resamples between the
context rate and 16 kHz, and the WebSocket. Calls need a secure context (HTTPS or localhost) for the microphone.

## 6. Security model

**Threats considered:** internet attackers reaching the login page, CSRF/XSS against the owner's browser,
malicious message content (HTML/SVG/scripts inside messages or media), theft of disk or backups,
lateral movement between containers, brute force, and (with calls) someone listening to or placing calls.

**Accepted / out of scope:** a fully compromised running host (it can read process memory and the live WA
session), and WhatsApp's own terms of service (unofficial client; ban risk is the user's decision).

### Authentication
* Single owner. Signup is closed permanently once an owner exists and requires `SETUP_TOKEN`
  (constant-time compare, rate limited).
* Password: min 12 characters, max 256, rejected if it matches the username or a small common-password list.
  `master = scrypt(pw, salt32, N=2^17, r=8, p=1, 32B)`, `authHash = HKDF(master, "wal/v1/auth")` (stored),
  `KEK = HKDF(master, "wal/v1/kek")` (never stored).
* Optional TOTP (RFC 6238, SHA-1, 6 digits, ±1 step, replay-protected by storing the last used step). The secret is
  encrypted with a key derived from the KEK, so it is only readable after a correct password.
* Recovery key: 32 random bytes shown once as Base32 groups. It wraps a second copy of the private key
  (`HKDF(scrypt(recoveryKey, salt), "wal/v1/recovery-kek")`). Recovery = recovery key + new password.
  It disables TOTP and rotates the recovery key.
* Brute force (`auth/throttle.ts`): every credential check (login, TOTP, password re-entry, recovery) is
  *charged before* scrypt runs, synchronously, so parallel requests cannot race past a lock. The lock is **per IP**
  (after 5 failures: 30 s … 1 h exponential), so one attacker's failures don't lock the owner's IP. It is backed by a
  **global** per-account counter in the DB (after 50 consecutive failures from any IPs: one attempt per 30 s … 15 min).
  Anyone who can reach the login can keep that global lock engaged, which delays the owner's password logins too;
  existing sessions keep working, and recovery (256-bit key) only uses the per-IP limit and resets the global counter.
  Route rate limits come on top. All auth events go to `audit_log`.
* TOTP codes are consumed atomically (`UPDATE … WHERE totp_last_step < step`), so a code works once even in
  parallel requests. Enabling 2FA needs the password (a stolen session alone can't lock the owner out). Wipe and
  recovery-key rotation need the password **and** the 2FA code when 2FA is enabled.
* After password changes, recovery, 2FA changes and session revocation, the SQLite WAL is checkpointed and
  truncated (`secure_delete=ON` zeroes freed pages), so superseded key wraps don't stay on disk.

### Sessions
* Cookie `__Host-wal_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`). Value is
  `b64url(sid32).b64url(secret32)`. The DB stores `sha256(sid)` and the owner private key encrypted under
  `HKDF(secret, "wal/v1/session")`. **A DB dump without a live cookie cannot decrypt anything.**
* Idle timeout `SESSION_IDLE_HOURS` (default 8) and absolute `SESSION_MAX_DAYS` (default 7). Sessions can be listed and revoked, including "log out everywhere".
  A password change revokes all other sessions.
* `COOKIE_SECURE=false` (dev/HTTP only) drops the `__Host-` prefix and `Secure`, and logs a loud warning.

### CSRF / request integrity
* "Is this an API request?" is decided from the **matched route** (`req.routeOptions.url`), never the raw URL.
  The router percent-decodes paths, so `/%61pi/...` must not skip the auth hook. A second `preHandler` layer
  re-checks the session for every matched non-public `/api` route. Absolute-form request targets are rejected.
* Requests whose TCP peer is the Chromium container are refused. Chromium shares the backend network with the
  app, but must never talk to the app.
* Every non-GET `/api` request must have `Content-Type: application/json` and an `Origin` that matches `PUBLIC_ORIGIN`
  (or the request `Host` when that is unset). Authenticated non-GET requests must also carry
  `X-CSRF-Token = HMAC(HKDF(secret,"wal/v1/csrf"), "csrf")`, which `GET /api/state` returns.
* The WebSocket (`/api/vnc`) and SSE (`/api/events`) require a valid session cookie and a matching `Origin`.

### Calls
* Who can listen: only a valid session (cookie) from our Origin can open `WS /api/calls/audio`, and audio flows only
  for a call the owner started or answered (or one answered in WA Web), to one client at a time. A stolen session can
  call and listen like the owner can send; revoking sessions closes the socket within 30 s (immediately on revoke events).
* What the Chromium page can do: the page (WhatsApp Web) can feed the app arbitrary call events and audio through the
  two bindings. Payloads are size-capped and validated (call ids and JIDs by pattern, PCM even-length ≤ 16 KiB base64)
  and only ever forwarded to the attached client as binary audio; nothing from the page is rendered as HTML.
* The browser's microphone is opened only after a click on Call / Answer / Join audio and is released when the call
  ends. The Chromium container still has no microphone permission or device: WhatsApp Web only gets the virtual one.
* No call audio is stored or logged; logs carry direction, reason and duration only.

### Encryption at rest (envelope, public-key)
The logger writes while the owner is logged out, but must not be able to read old data without the owner.
* At signup: an X25519 keypair. The public key is stored in plaintext. The private key (PKCS8) is AES-256-GCM encrypted under the
  password KEK and, as a second copy, under the recovery KEK.
* **DEK (data key):** random 32 bytes, created at each process start and rotated every 24h. It is wrapped with ECIES
  to the owner's public key (ephemeral X25519 → ECDH → `HKDF(shared, salt=ephPub‖ownerPub, "wal/v1/dek")` →
  AES-256-GCM) and stored in `data_keys`. Only the current DEK is kept in memory for writing.
* **Fields:** `0x01 ‖ keyId(u32be) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, AES-256-GCM with
  AAD = `"wal/v1|<table>|<column>|<rowId>"` (this stops ciphertexts from being swapped between rows or columns).
* **Media files:** header `"WAL1" ‖ version ‖ keyId(u32be) ‖ noncePrefix(8)`, then 64 KiB plaintext chunks, each
  AES-256-GCM with nonce = `prefix ‖ u32be(chunkIndex)` and AAD = `"wal/v1|media|<mediaId>|<chunkIndex>|<final?>"`.
  This enables HTTP Range requests (decrypt only the needed chunks) and detects truncation or reordering.
  Files are stored as `/data/media/<2 hex>/<uuid>.bin` (random names, no plaintext hashes).
* **Reading:** a session request unlocks the private key (with the session secret from the cookie) and unwraps the needed
  DEKs. Unwrapped DEKs and private keys are cached in memory for at most 10 minutes and cleared on logout,
  password change and wipe.
* **Encrypted:** message bodies and captions, `meta` JSON (quoted snapshot, location, vCard, poll, mentions, links),
  thumbnails, edit history, reaction emoji, chat names, contact names, pushnames, and all media (including avatars)
  with their mime type and filename.
* **Plaintext (metadata):** WA IDs (these contain phone numbers), timestamps, message types, flags (deleted/edited/fromMe/
  forwarded), the disappearing-messages timer, acks, and media sizes/dimensions. Documented. Host full-disk encryption is recommended.
* A password change re-wraps only the private key (cheap). A lost password plus a lost recovery key means **the data is gone by design**.

### HTTP hardening
* CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:;
  connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
* HSTS (when secure), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`
  (all powerful features disabled), `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` on `/api/*`.
* Media responses: a fixed allowlist of inline-safe MIME types (raster images excluding SVG, audio/*, video/*).
  Everything else is served as `application/octet-stream` with `Content-Disposition: attachment` and a
  `Content-Security-Policy: sandbox; default-src 'none'` response header. Filenames are sanitized.
* Message text is never rendered as HTML. Links get `rel="noopener noreferrer nofollow"` and `target=_blank`.
  No link previews are fetched.
* zod validates every body, query and params. Errors are generic, and internal details are logged with a
  request ID and never returned to the client.
* Logs never contain message content, names, cookies or secrets (pino `redact` plus a code discipline enforced by review).

## 7. Database (SQLite, `/data/wa_logger.db`, WAL, `foreign_keys=ON`)

```sql
owner(id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, pw_salt BLOB, pw_auth_hash BLOB,
      public_key BLOB, privkey_pw BLOB, privkey_recovery BLOB, recovery_salt BLOB, recovery_auth_hash BLOB,
      totp_secret_enc BLOB, totp_enabled INTEGER DEFAULT 0, totp_last_step INTEGER,
      failed_logins INTEGER DEFAULT 0, locked_until INTEGER, created_at INTEGER, password_changed_at INTEGER)
sessions(id_hash BLOB PRIMARY KEY, privkey_enc BLOB, created_at, last_seen_at, expires_at, ip TEXT, user_agent TEXT)
audit_log(id INTEGER PRIMARY KEY, ts INTEGER, event TEXT, ip TEXT, detail TEXT)          -- no message content
app_state(key TEXT PRIMARY KEY, value TEXT)                                              -- onboarding_complete, settings JSON…
data_keys(id INTEGER PRIMARY KEY, eph_pub BLOB, nonce BLOB, wrapped BLOB, created_at INTEGER)
chats(id TEXT PRIMARY KEY, kind TEXT, name_enc BLOB, last_ts INTEGER, last_message_id TEXT, archived INTEGER,
      pinned INTEGER, muted INTEGER, removed_at INTEGER, avatar_media_id INTEGER, created_at, updated_at)
contacts(id TEXT PRIMARY KEY, name_enc BLOB, pushname_enc BLOB, phone_enc BLOB /* migration 2 */,
         is_me INTEGER, is_business INTEGER, avatar_media_id INTEGER, avatar_checked_at INTEGER, updated_at)
messages(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT, from_me INTEGER, ts INTEGER, type TEXT,
         body_enc BLOB, meta_enc BLOB, thumb_enc BLOB, quoted_id TEXT,
         media_id INTEGER, media_status TEXT, media_attempts INTEGER, media_size INTEGER, media_w INTEGER,
         media_h INTEGER, media_duration INTEGER,
         is_view_once INTEGER, is_forwarded INTEGER, is_status INTEGER, ack INTEGER,
         deleted_at INTEGER, deleted_by TEXT, deleted_for_me_at INTEGER, edited_at INTEGER, last_edit_key TEXT,
         source TEXT, captured_at INTEGER, updated_at INTEGER)
  INDEX messages(chat_id, ts), INDEX messages(deleted_at) WHERE deleted_at IS NOT NULL
message_edits(id INTEGER PRIMARY KEY, message_id TEXT, body_enc BLOB, captured_at INTEGER)
reactions(message_id TEXT, sender_id TEXT, emoji_enc BLOB, ts INTEGER, removed_at INTEGER, PRIMARY KEY(message_id, sender_id))
media(id INTEGER PRIMARY KEY, path TEXT, key_id INTEGER, mime_enc BLOB, filename_enc BLOB, size INTEGER, created_at INTEGER)
```
Migrations live in `server/src/db/db.ts` (`MIGRATIONS`, append-only), are applied in a transaction at startup
and tracked in `schema_migrations`. Message ids are the rebuilt WA keys. Message bodies and their edit history share the
AAD context `msgbody|<messageId>`, so an edit can move the old ciphertext into `message_edits` without decrypting.

## 8. HTTP API (JSON; DTO types in `shared/api.d.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/state | – | `{hasOwner, authenticated, onboardingComplete, csrfToken?, wa?}` |
| POST | /api/auth/signup | setup token | create owner → `{recoveryKey}` + session |
| POST | /api/auth/login | – | `{username,password,totp?}` → session (`{needTotp:true}` if missing) |
| POST | /api/auth/logout · /api/auth/logout-all | ✓ | |
| POST | /api/auth/recover | – | `{username, recoveryKey, newPassword}` → `{recoveryKey}` (new) |
| POST | /api/auth/password | ✓ | `{currentPassword,newPassword}` |
| GET/DELETE | /api/auth/sessions[/:id] | ✓ | list / revoke |
| POST | /api/auth/totp/setup · enable · disable | ✓ | TOTP enrollment |
| POST | /api/auth/recovery-key/rotate | ✓ | `{password}` → new recovery key |
| GET | /api/wa/status | ✓ | `WaStatus` |
| POST | /api/wa/restart · /api/wa/logout | ✓ | reconnect / unlink device |
| POST | /api/onboarding/complete | ✓ | requires WA `ready` |
| GET | /api/vnc/credentials | ✓ | `{password}` for noVNC |
| WS | /api/vnc | ✓ | binary bridge to chromium:5900 |
| GET | /api/chats | ✓ | `ChatSummary[]` (sorted pinned, last_ts desc) |
| GET | /api/chats/:chatId/messages?before=&limit= | ✓ | `MessagePage` (newest-first pages) |
| GET | /api/chats/:chatId/messages/around/:messageId | ✓ | page centered on a message (jump to quote/search hit) |
| GET | /api/messages/:messageId/edits | ✓ | edit history |
| GET | /api/media/:mediaId | ✓ | decrypted stream, Range supported |
| GET | /api/media-zip?ids= | ✓ | several message media files (media ids, ≤ 500, < 4 GB) as one ZIP: stored entries, decrypted while streaming, exact Content-Length (web "Select → Download ZIP") |
| POST | /api/messages/:messageId/media/retry | ✓ | re-queue download |
| GET | /api/deleted?before= | ✓ | feed of deleted messages across chats |
| GET | /api/media-feed?after=&limit= | ✓ | `MediaFeedPage`: media downloaded after a cursor (media id), oldest first; no `after` = current cursor only (Android auto-save) |
| GET | /api/search?q=&chatId= | ✓ | decrypt-and-scan search (bounded) |
| POST | /api/chats/:chatId/send | ✓ | `{text, quotedId?}` → `SendResult` |
| POST | /api/uploads | ✓ | raw file (octet-stream, `X-Filename`, `X-File-Type`) → `{uploadId, size}`; DELETE /api/uploads/:id cancels |
| POST | /api/chats/:chatId/send-media | ✓ | `{uploadId, kind: auto\|document\|voice\|gif, caption?, quotedId?}` |
| POST | /api/messages/:messageId/react · revoke · edit | ✓ | `{emoji}` ('' removes) · – · `{text}` |
| POST | /api/chats/:chatId/read · /api/chats/new | ✓ | send read receipts · `{phone}` → `{chatId}` |
| GET | /api/calls/current | ✓ | `CurrentCall` (`{call, available}`; the call with the decrypted name) |
| POST | /api/chats/:chatId/call | ✓ | `{}` → `CallInfo` (voice call to a one-to-one chat; 409 while another call is going on) |
| POST | /api/calls/:callId/accept · reject · hangup | ✓ | answer (voice) / decline / end |
| WS | /api/calls/audio | ✓ | call audio both ways: binary 16 kHz mono s16le frames (`CallAudioHello` first) |
| GET | /api/events | ✓ | SSE: `wa_state`, `message`, `message_update`, `chat_update`, `sync_progress`, `call` |
| GET/PUT | /api/settings | ✓ | `{logStatus, downloadHistoryMedia, mediaMaxMb, historyPerChat, readReceipts}` |
| GET | /api/audit | ✓ | audit log |
| POST | /api/data/wipe | ✓ + password | delete all logged messages/media (keeps owner) |

## 9. Configuration (`.env`, generated by `scripts/setup.sh`)

`SITE_ADDRESS` (e.g. `wa.example.com` or `192.168.1.50`), `CADDY_TLS` (`internal` or an ACME email),
`PUBLIC_ORIGIN` (e.g. `https://wa.example.com`; optional in HTTP mode), `SETUP_TOKEN`, `VNC_PASSWORD`,
`COOKIE_SECURE` (`true` default | `auto` | `false`), `CADDY_CONFIG` (`Caddyfile` | `Caddyfile.http`),
`HTTP_PORT`/`HTTPS_PORT`, `HTTP_BIND`/`HTTPS_BIND` (bind address of the published ports), `WAL_VERSION` (image tag),
`SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`, `MEDIA_MAX_MB` (default 100), `HISTORY_PER_CHAT` (200),
`RECONCILE_MINUTES` (10), `CHROMIUM_HOST` (`chromium`), `CDP_PORT` (9223), `VNC_PORT` (5900),
`SCREEN` (`1280x800x24`), `LOG_LEVEL` (info), `TRUST_PROXY` (proxy hops: 1 = bundled Caddy, 2 = + external proxy,
3 = + another proxy/CDN in front of that; see §3 for why it must match).

## 10. Testing

* `server`: vitest. Covers crypto round-trips and tamper/AAD-mismatch failures, chunked range decrypt, auth flows through
  `fastify.inject` (signup gating, login, lockout, CSRF/Origin, session expiry, recovery), a route-table test
  asserting that every `/api` route except the public allowlist rejects anonymous requests, mapper fixtures for
  every message type, and revoke/edit/reaction ingest.
* `web`: vitest for the formatting parser (including injection attempts), `tsc --noEmit`, and a production build.
* `server/src/wa/client.test.ts` drives the real WaService event wiring with a fake whatsapp-web.js client
  (ordering, revoke, edit, reactions, states). `auth.test.ts` also covers encoded-path bypasses, parallel
  lockout races, TOTP replay races, WAL scrubbing and `COOKIE_SECURE=auto`.
* `scripts/smoke.sh` (23 checks: TLS incl. no-SNI, headers, cookies, CSRF/Origin, signup, WA reaches `qr`, VNC
  `RFB 003.00x`, no app egress, Chromium sandbox) and `scripts/smoke.sh --deploy` (the standalone layout).
* Calls: `wa/callpage.test.ts` runs the injected source in a `vm` against fake WhatsApp modules and fake Web Audio,
  `api/calls.test.ts` covers the routes, the audio WebSocket and the call state machine. `scripts/dev/call-audio.mts`
  checks the audio path inside the real Chromium image (tab and popout, both output routes) and `scripts/dev/call-ui.mts`
  drives the call UI in a real browser with a fake microphone.
* `scripts/dev/` has a full-UI browser walkthrough (61 steps) and a live-update (SSE) test. `scripts/wa-diagnose.js`
  checks a *running* instance against WhatsApp Web changes (see §11).

## 11. Deployment & operations

* **Images:** CI (`.github/workflows/ci.yml`) runs tests, then builds and publishes
  `ghcr.io/revocx35/wa_logger-{app,chromium,caddy}` (tags `latest`, `x.y.z`, `sha-…`) on pushes to `main` and `v*` tags.
  The packages are public. All GitHub Actions are pinned by commit SHA.
* **Topologies:** (a) from source: `docker-compose.yml` builds the images; (b) prebuilt: `deploy/docker-compose.yml`
  plus `seccomp-chromium.json` and `.env`; (c) either one in HTTP mode behind the user's TLS proxy
  (`setup.sh --http-only`); (d) an optional `docker-compose.override.yml` binds the four volumes to a dedicated,
  size-capped filesystem (README "cap storage").
* **Update:** `docker compose pull && docker compose up -d` (prebuilt) or `git pull && docker compose up -d --build`.
  The WhatsApp session survives restarts (it lives in the Chromium profile). Restarting only `app` does not touch
  Chromium: `docker compose up -d --no-deps app`.
* **Backups:** `app_data` (encrypted; useless without the password or recovery key) and `chromium_profile` (the live
  WhatsApp session: treat it as a credential).
* **When WhatsApp Web changes break something** (history import fails, names missing, media not downloading):
  run `docker compose exec -T app node - < scripts/wa-diagnose.js` on the host. It prints only aggregates (no
  content): WhatsApp Web version, chat counts, whether whatsapp-web.js chat helpers still work, whether rebuilt
  message keys still match `MsgKey.toString()`, media stages, and DB stats. Then check `docs/wwebjs-notes.md`.

## 12. Android client — `android_client/`

A native client for the same API (no WebView, no server changes needed). Kotlin 2.4, Jetpack Compose,
AGP 9.4 (built-in Kotlin), Gradle 9.8 (wrapper with pinned checksum), minSdk 26, compile/target SDK 37.
Package `io.github.revocx35.walogger` (debug builds get the `.debug` suffix and install side by side).
Current release: 0.6.0 (versionCode 7: voice calls). 0.5.0 (versionCode 6: sending). 0.4.0 (versionCode 5:
multi-select photos/videos in a chat and save them to the gallery).
0.3.0 (versionCode 4: auto-save with a disappearing-messages-only option, Android 17 local network
permission). 0.1.1 (versionCode 2) was confirmed working by the owner on a Samsung, One UI 8.5 / Android 16,
server in HTTP mode.

### Modules
* `core/` — pure Kotlin/JVM (no Android classes), so protocol code is tested without an emulator:
  * `Models.kt` mirrors `shared/api.d.ts`. Every field has a default where possible, unknown enum values fall
    back to a default (`coerceInputValues`), numbers that may be fractional are `Double` (media width/height).
  * `ApiClient` — OkHttp + kotlinx.serialization. Adds the browser-equivalent `Origin` header to requests
    for the configured server (the server's Origin/CSRF checks apply unchanged), `X-CSRF-Token` on non-GET,
    never follows redirects (a 3xx becomes an error that names the target), maps transport errors to
    `ApiException` codes (`network`, `tls_untrusted`, `tls`, `redirect`, `not_wa_logger`). `probe()` checks
    that `/api/state` really comes from wa_logger. **The whole request (send, body read, JSON decode) runs
    in `withContext(Dispatchers.IO)`**: callers are on Android's main thread, where socket reads throw
    `NetworkOnMainThreadException` (the 0.1.0 bug, see DEVLOG). `MainThreadNetworkTest` enforces this.
  * `EventStream` — SSE (`/api/events`) with backoff 3 s→30 s, 65 s read timeout (server heartbeat 20 s),
    stops on 401; `reopened` fires after a reconnect so screens reload what they missed.
  * `WaText` (1:1 port of `web/src/lib/waText.tsx`, same test cases, same linear-time guarantees, UTF-16
    indexing like JS; Extended_Pictographic table built in because Android's regex engine differs by version)
    and `Format` (port of `format.ts`; `colorFor` gives the web's exact colors).
  * `vnc/` — RFB 3.3/3.7/3.8 client over the `/api/vnc` WebSocket bridge: VNC auth with a built-in DES
    (not every Android provider has plain DES), Raw/CopyRect/ZRLE, DesktopSize/LastRect; the remote
    clipboard is skipped and never kept. Our pixel format is 32 bpp little-endian, so a ZRLE CPIXEL is B,G,R.
* `app/` — the Android UI:
  * `ui/theme` — the web's CSS tokens (`WaColors`, light/dark following the system) and the web's SVG icon
    paths (`WaIcons`, generated from `web/src/components/Icon.tsx` plus a few extras). Custom components
    (`ui/components`) reproduce `.btn`, `.pill`, `.badge`, `.chip`, `.search-box`, bubbles, etc.
  * Screens mirror the web pages. Layout switches at 900 dp like the web: bottom rail on phones (hidden in a
    chat), side rail + two panes on tablets. Navigation Compose with type-safe routes (`MainShell.kt`).
    Screens take small state interfaces (`ChatState`, `ChatListState`, `DeletedState`) so screenshot tests
    can render them with fake data.
  * `data/` — `AppGraph` (singletons; `ServerSession` per server with its `ApiClient`, `EventStream`, Coil
    image loader, shared audio player), `AppController` (the web's route guard: server → signup →
    login/recover → recovery key → link → main; events run only in the foreground while logged in),
    `SecureCookieJar` (session cookie AES-GCM-encrypted with a non-exportable Android Keystore key in
    `noBackupFilesDir`, loaded lazily on a network thread, never throws on OkHttp threads), `ServerTrust`
    (system CAs first; certificates the owner imports or confirms by SHA-256 fingerprint are trusted only
    for the configured server host; hostname verification unchanged), `Prefs`, `Diagnostics`.
  * `media/` — one shared ExoPlayer for voice notes, full-screen viewer (zoomable photos, streamed
    video/GIF via OkHttp data source with Range), save through the system file picker, "open with" through
    a FileProvider copy in the app cache (deleted at the next start).
  * Multi-select (`ui/Selection.kt`): long-press a downloaded photo/video/GIF in a chat to start selecting, tap to
    toggle, "Select all" takes every savable item loaded in the chat; the header's save button writes them to the
    gallery one after another (`MediaOps.saveToGallery`, shared with auto-save) on the session scope, so leaving the
    chat doesn't stop it. Back clears the selection. Long-press on other messages still copies their text.
  * `media/AutoSave.kt` — opt-in "Save new photos to this phone" (Settings → App, Android 10+): walks
    `GET /api/media-feed` from a cursor taken when it was switched on (only newly logged media) and writes photos
    (optionally videos/GIFs, optionally status updates; never stickers) to `Pictures/wa_logger` /
    `Movies/wa_logger` through MediaStore (no storage permission). Triggered by `message_update` media events and
    app start while in the foreground, and by a 15-minute WorkManager job (network required) in the background.
    Option "Only from chats with disappearing messages" saves only media whose `Message.disappearingSec` is set:
    exactly the media WhatsApp's own app never saves to the gallery (the server stores WhatsApp's per-message
    `ephemeralDuration` as `messages.ephemeral_sec`; rows logged before 2026-10-10 get it when the message is seen again).
    The cursor is stored per server and advanced per item, so an interrupted run doesn't save duplicates. The copies
    are unencrypted by design (the setting says so) and the run keeps the session cookie in use.
  * `ui/vnc/VncView` — double-buffered bitmap, tap = click, drag = wheel scroll (pan when zoomed or
    view-only), pinch = zoom, keyboard bar that sends typed text as keysyms (needed for "Log in with phone
    number" when WhatsApp is on the same phone).

### Robustness and diagnostics
* App and session coroutine scopes carry a `CoroutineExceptionHandler` that records failures instead of
  crashing; view models report unexpected (non-API) errors through `ServerSession.fail()`.
* `Diagnostics` writes local crash reports (uncaught exceptions) and picks up ANR traces of the main thread
  from `ApplicationExitInfo` (Android 11+). The next start shows them with a Copy button (also Settings →
  App → Crash reports). Reports hold stack frames, exception types, sanitized messages (JSON input excerpts
  removed), app/Android version and phone model — never content — and are never sent anywhere. When the owner
  reports a problem, ask for this report first.
* Lists are de-duplicated before `LazyColumn` (duplicate keys crash Compose); jump-to-message uses
  `scrollToItem` + `scrollBy` (no negative offsets).

### Security choices
Android 17 (target SDK 37) blocks connections to private addresses unless the owner grants `ACCESS_LOCAL_NETWORK`
(shown as "Nearby devices"): `data/LocalNetwork.kt` asks when connecting to a local address and offers it on the
"cannot reach" screen. Without it, a home-network server is unreachable (found on the emulator, 2026-10-10).
Auto-save is the only path that writes decrypted media outside the app on its own; it is off by default.
`FLAG_SECURE` on by default (switch in Settings → App), `allowBackup=false` + data extraction rules excluding
everything, no disk cache for media (Coil memory cache only, ExoPlayer without cache), user-installed CAs not
trusted (network security config), cleartext allowed by the platform config but gated in the app (explicit
confirmation for HTTP to a non-private address), only `http(s)` links are tappable, copied message text is
marked sensitive. Sending (0.5.0): `ui/Sending.kt` `MessageSender` (implemented by `data/ServerSender.kt` over the send
API; wa_logger mobile implements the same interface locally), `ui/components/Composer.kt` (composer, long-press
`MessageMenu`, `NewChatDialog`), `media/VoiceRecorder.kt` (MediaRecorder Ogg/Opus, Android 10+, `RECORD_AUDIO` asked on
first use; the recording stays in the private cache and is deleted after sending). Files are streamed from their
content URI (`RequestBody`), never loaded whole into memory.

### Calls (0.6.0)
* `core/CallAudio.kt`: `CallAudioSocket` (OkHttp WebSocket to `/api/calls/audio`; the cookie jar and Origin interceptor
  apply; checks the `CallAudioHello`; close codes → `CallAudioEnd`; callbacks never throw on OkHttp's thread) and
  `JitterBuffer` (80 ms prebuffer, backlog above 300 ms dropped). Models: `CallInfo`, `CurrentCall`,
  `ServerEvent.CallChanged`; ApiClient: `currentCall`, `startCall`, `acceptCall`, `rejectCall`, `hangupCall`.
* `media/CallAudioEngine.kt`: `AudioRecord` (`VOICE_COMMUNICATION` source, 16 kHz mono, plus `AcousticEchoCanceler` /
  `NoiseSuppressor` when available) → 20 ms frames → socket, socket → JitterBuffer → `AudioTrack`
  (`USAGE_VOICE_COMMUNICATION`, blocking writes pace it). Two daemon threads; `MODE_IN_COMMUNICATION` and transient
  audio focus during the call; earpiece by default, loudspeaker via `setCommunicationDevice` (API 31+).
* `data/CallController.kt` (one per `ServerSession`, implements `ui/Calls.kt` `CallActions`): the web CallProvider's
  logic (SSE `call` events + `GET /api/calls/current`, ringtone/vibration for incoming calls, `ToneGenerator`
  ringback, ended calls shown for 4 s, "Join audio"). While a call goes on the event stream keeps running in the
  background (`AppController.syncEvents`).
* `media/CallForegroundService.kt`: foreground service of type `microphone` while audio flows (Android blocks the
  microphone for background apps otherwise), ongoing notification with Hang up, private on the lock screen.
* UI: `ui/components/CallPanel.kt` floats above the shell (`MainShell`), `CallButton` in one-to-one chat headers,
  permissions asked in the click (`RECORD_AUDIO`, `POST_NOTIFICATIONS` on 13+). Manifest adds `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`.
* Verified on the emulator (Android 17) against `scripts/dev/call-ui.mts` with `SERVE=1`: outgoing call, microphone
  audio arriving at the server, mute, call continuing in the background with the service, Hang up from the
  notification, incoming call answered and ended by the other side, decline.

### Build, test, release
* Tests: `:core:test` (unit tests incl. the UI-thread rule, ZRLE/RFB/DES, MockWebServer client tests),
  `:app:testDebugUnitTest` (Robolectric renders of every main screen; `recordRoborazziDebug` writes PNGs to
  `app/build/screenshots/` to compare with the web's `docs/screenshots`), and `LiveServerTest` (opt-in via
  `WAL_IT_*` env vars) against a real stack: `scripts/smoke.sh --keep`, seed with `server/src/testutil/seed.ts`
  into the stack's `app_data` volume (`chown -R 10001:10001` afterwards), trust Caddy's `root.crt`.
* The dev LXC has KVM and an emulator (AVD `wal_test`, Android 17 / API 37 google_apis x86_64). On-device tests in
  `app/src/androidTest` (`:app:connectedDebugAndroidTest`; auto-save: MediaStore writes, WorkManager) aren't in CI
  (no emulator there), so run them before a release. UI walkthroughs: `adb shell uiautomator dump` (screenshots are
  black while FLAG_SECURE is on). Full auto-save end-to-end: `scripts/dev/autosave-server.mts` (see its header).
  Code that only misbehaves on Android (threading rules, Keystore, R8, new permission rules) is invisible to the
  JVM tests.
* **R8 is disabled** for release builds (`isMinifyEnabled = false`): minified builds couldn't be verified
  (0.1.0's mapping renamed route classes; Navigation resolves route serializers reflectively). Re-enable
  only after testing a minified build on an emulator/device; `proguard-rules.pro` is kept for that.
* CI job `android`: `:core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` and uploads the
  debug APK artifact.
* Releases are manual (the signing key never goes to CI): bump `versionCode`/`versionName` in
  `app/build.gradle.kts`, build `assembleRelease` from a clean clone, `gh release create android-vX.Y.Z <apk>`
  with the APK and signing-certificate SHA-256 in the notes. Use the `android-v` tag prefix: plain `v*` tags
  make CI publish versioned server images. Updates must be signed with the same key (location in Claude's
  project memory, not in the repo).
