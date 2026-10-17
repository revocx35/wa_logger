# Developer test tools

These tools need a **test browser**: a Chromium with DevTools on `127.0.0.1:9333`, without wa_logger's
WhatsApp-only URL policy. The wa_logger chromium image works (the empty directory masks the policy file):

```bash
mkdir -p /tmp/emptypol
docker run -d --name uitest --network host --shm-size 512m \
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

## call-ui.mts — calls in a real browser (24 steps)

The real server, `CallService` and audio WebSocket with a fake WhatsApp tab whose call models change state like
WhatsApp Web's and whose "other side" speaks a 440 Hz tone. Covers an outgoing call (calling → ringing → connected,
microphone audio arriving, the tone audible in the page, mute/unmute, hang up), an incoming call answered and ended by
the other side, declining, "answered on another device", "Join audio" after a reload, and the phone layout. Start the
test browser with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (no autoplay flag needed).

```bash
(cd web && npm run build)
cd server && npx tsx ../scripts/dev/call-ui.mts
```

## call-audio.mts — call audio inside the real Chromium image (12 checks)

callpage.ts' virtual microphone and speaker tap, installed by the real `CallBridge`, against a fake "WhatsApp" audio
graph built like WhatsApp Web's (capture from getUserMedia at 16 kHz; playback through a worklet into an `<audio>` or
straight to the output), in the tab and in a popout window. It needs the chromium image running **its own entrypoint**
(Xvfb, no sound devices, sandbox, managed policy) with `localhost` allowed:

```bash
mkdir -p /tmp/pol && python3 -c "import json;p=json.load(open('chromium/policies.json'));p['URLAllowlist'].append('localhost');json.dump(p,open('/tmp/pol/wa_logger.json','w'))"
docker run -d --name walcalltest --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --security-opt seccomp=chromium/seccomp-chromium.json -e VNC_PASSWORD=testtest123 -e BIND_ADDRESS=127.0.0.1 \
  -e CDP_PORT=19223 -e VNC_PORT=15900 -v /tmp/pol:/etc/chromium/policies/managed:ro \
  --tmpfs /tmp:size=512m --tmpfs /home/chrome:uid=10002,gid=10002,mode=0700 --tmpfs /data:uid=10002,gid=10002,mode=0700 \
  --shm-size 1g wa_logger-chromium:local
cd server && npx tsx ../scripts/dev/call-audio.mts
```

## e2e-ui.mjs — full UI walkthrough (61 steps)

1. `scripts/smoke.sh --keep` (prints the project name, URL and env file), then seed sample data into its volume:
   ```bash
   . <env file>
   docker run --rm -u 10001:10001 -e DATA_DIR=/data -e SETUP_TOKEN=$SETUP_TOKEN -e VNC_PASSWORD=$VNC_PASSWORD \
     -e NODE_ENV=development -e HOME=/tmp -v <project>_app_data:/data -v "$PWD/server":/srv:ro -w /srv \
     node:24-trixie-slim node_modules/.bin/tsx src/testutil/seed.ts
   ```
2. `BASE=https://localhost:28443 node scripts/dev/e2e-ui.mjs` covers login, onboarding, every message type,
   deleted/edited/quoted messages, lightbox and downloads, infinite scroll, search, WA Web, settings (2FA,
   password change, recovery key), the mobile layout and wipe. It reports any browser error or failed request.

## Probing a live WhatsApp Web (read-only)

`scripts/wa-diagnose.js` (see ARCHITECTURE.md §11) is the safe way to check a running instance. Ad-hoc probes can
connect to Chromium's CDP (`http://<chromium backend IP>:9223`, found via
`docker inspect wa_logger-chromium-1`) and `page.evaluate()` inside the WhatsApp tab. Rules:
- Never print message content, names or numbers.
- Never navigate, click, send or close the tab.
- Don't declare named helper functions inside `evaluate()` when running through `tsx`: esbuild wraps them with
  `__name`, which doesn't exist in the page. The production build (tsc) doesn't do this.
