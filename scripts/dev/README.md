# Developer test tools

These tools need a **test browser**: a Chromium with DevTools on `127.0.0.1:9333`, without wa_logger's
WhatsApp-only URL policy. The wa_logger chromium image works (the empty directory masks the policy file):

```bash
mkdir -p /tmp/emptypol
docker run -d --name uitest --network host --shm-size 512m -u 10002:10002 -e HOME=/tmp \
  --security-opt seccomp=chromium/seccomp-chromium.json \
  -v /tmp/emptypol:/etc/chromium/policies/managed:ro --entrypoint chromium \
  ghcr.io/revocx35/wa_logger-chromium:latest --headless=new --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/p --no-first-run --ignore-certificate-errors about:blank
```

## live-updates.mts — SSE live updates in a real browser

Starts the real server in-process (test harness, built web UI) and injects WhatsApp-shaped events through
the real ingest code. New chats, messages, deletions and edits must appear without a reload, and revoked
sessions must be logged out live.

```bash
(cd web && npm run build)
cd server && npx tsx ../scripts/dev/live-updates.mts
```

## send-ui.mts — sending in a real browser (17 steps)

The real server and `Sender` with a fake WhatsApp page whose operations behave like WhatsApp Web's (sent messages
come back through ingest). Covers text with line breaks, reply, reaction, edit, delete for everyone, a photo with a
caption (stored from the upload), a voice note recorded by the browser's fake microphone (checked to decode as
Ogg/Opus), a new chat by number and the phone layout. Start the test browser with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` for the voice step.

```bash
(cd web && npm run build)
cd server && npx tsx ../scripts/dev/send-ui.mts
```

## call-ui.mts — calls in a real browser (39 steps)

The real server, `CallService` and audio WebSocket with a fake WhatsApp tab whose call models change state like
WhatsApp Web's and whose "other side" speaks a 440 Hz tone. Covers an outgoing call (calling → ringing → connected,
microphone audio arriving, the tone audible in the page, mute/unmute, hang up), an incoming call answered and ended by
the other side, declining, "answered on another device", "Join audio" after a reload, and the phone layout. Start the
test browser with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (no autoplay flag needed).

```bash
(cd web && npm run build)
cd server && npx tsx ../scripts/dev/call-ui.mts
```

`SERVE=1` only runs the server on `0.0.0.0:18094` (the Android emulator reaches it at `http://10.0.2.2:18094`, user
`owner`) and prints the call state, the audio bridge and the received microphone bytes every second. Commands on stdin:
`incoming` (a call rings), `incomingvideo`, `hangup` (the other side ends it), `check` (decodes the last camera frames the
client sent; with `CHECK_PNG=<file>` the last one is saved, turned as its header says), e.g. through a FIFO:
`tail -f fifo | SERVE=1 npx tsx …`. With the test browser running, the other side sends H.264 video.

## call-video.mts — call video inside the real Chromium image (9 checks)

The other side's H.264 (real WebCodecs output) handed to a fake renderer registry the way WhatsApp's wasm stack does,
out through the real `CallBridge`, decoded again in a second page (must be red); and the owner's VP8 with a rotation
into WhatsApp's `getUserMedia` camera (must be blue, rotated). Same container as below.

```bash
cd server && npx tsx ../scripts/dev/call-video.mts
```

## call-audio.mts — call audio inside the real Chromium image (12 checks)

callpage.ts' virtual microphone and speaker tap, installed by the real `CallBridge`, against a fake "WhatsApp" audio
graph built like WhatsApp Web's (capture from getUserMedia at 16 kHz; playback through a worklet into an `<audio>` or
straight to the output), in the tab and in a popout window. It needs the chromium image running **its own entrypoint**
(Xvfb, no sound devices, sandbox, managed policy) with `localhost` allowed:

```bash
mkdir -p /tmp/pol && python3 -c "import json;p=json.load(open('chromium/policies.json'));p['URLAllowlist'].append('localhost');json.dump(p,open('/tmp/pol/wa_logger.json','w'))"
docker run -d --name walcalltest --network host --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --cap-add CHOWN --cap-add KILL --security-opt no-new-privileges:true \
  --security-opt seccomp=chromium/seccomp-chromium.json -e CONTROL_SECRET=testtest123 -e LISTEN_ADDR=127.0.0.1:19223 \
  -v /tmp/pol:/etc/chromium/policies/managed:ro --tmpfs /tmp:size=512m --tmpfs /home/chrome:mode=0711 \
  --tmpfs /run/wal:mode=0711 --tmpfs /data:mode=0711 --shm-size 1g wa_logger-chromium:local
cd server && npx tsx ../scripts/dev/call-audio.mts
```

## e2e-ui.mjs — full UI walkthrough (61 steps)

1. `scripts/smoke.sh --keep` (prints the project name, URL and env file), then seed sample data into its volume:
   ```bash
   . <env file>
   docker run --rm -u 10001:10001 -e DATA_DIR=/data -e SETUP_TOKEN=$SETUP_TOKEN \
     -e NODE_ENV=development -e HOME=/tmp -v <project>_app_data:/data -v "$PWD/server":/srv:ro -w /srv \
     node:24-trixie-slim node_modules/.bin/tsx src/testutil/seed.ts
   ```
2. `BASE=https://localhost:28443 node scripts/dev/e2e-ui.mjs` covers login, onboarding, every message type,
   deleted/edited/quoted messages, lightbox and downloads, infinite scroll, search, WA Web, settings (2FA,
   password change, recovery key), the mobile layout and wipe. It reports any browser error or failed request.

## Probing a live WhatsApp Web (read-only)

`scripts/wa-diagnose.js` (see ARCHITECTURE.md §11) is the safe way to check a running instance. Ad-hoc probes can
connect to a user's Chromium through the manager (`managed-chromium.mts` here: `MANAGER`, `CONTROL_SECRET`, `INSTANCE`;
the manager's address is the chromium container's IP on the backend network, found via
`docker inspect wa_logger-chromium-1`) and `page.evaluate()` inside the WhatsApp tab. Rules:
- Never print message content, names or numbers.
- Never navigate, click, send or close the tab.
- Don't declare named helper functions inside `evaluate()` when running through `tsx`: esbuild wraps them with
  `__name`, which doesn't exist in the page. The production build (tsc) doesn't do this.

## multiuser-e2e.mts — multi-user against a running stack (35 checks)

Admin + two users on two extra ports against a real `docker compose` stack: first sign-in with the temporary password,
port policy, a separate Chromium and QR code per user, VNC per user, forged tenant cookies, and what only a real
deployment shows — unix users of the gateway, the workers and the browsers, file permissions between them, no
capabilities, Chromium sandbox on, and that deleting a user removes their data, browser and processes.

```bash
export COMPOSE_PROJECT_NAME=walmulti   # any project name; a scratch .env with HTTP_PORT=18090 EXTRA_PORTS=18101-18103 CADDY_CONFIG=Caddyfile.http COOKIE_SECURE=false
docker compose --env-file scratch.env up -d --build
cd server && BASE=http://127.0.0.1:18090 EXTRA_PORT=18101 SETUP_TOKEN=… PROJECT=walmulti npx tsx ../scripts/dev/multiuser-e2e.mts
```
