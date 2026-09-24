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
