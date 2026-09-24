#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016  # "check && ok || bad" is intended (ok/bad always succeed); remote shell snippets are single-quoted on purpose
# End-to-end smoke test in an ISOLATED compose project (own volumes, secrets and ports) — never
# touches your real deployment. Builds the images, starts the stack and checks:
#   health, security headers, cookie flags, signup, WhatsApp reaching the QR state, the VNC
#   bridge (RFB handshake), cross-origin rejection, and that the app container has no internet.
#
#   scripts/smoke.sh                 # source build (docker-compose.yml), test, tear down (volumes removed)
#   scripts/smoke.sh --deploy        # the standalone deploy/docker-compose.yml (prebuilt-image layout),
#                                    # run from an empty directory holding only the files a user downloads;
#                                    # images are built locally and tagged like the published ones
#   scripts/smoke.sh --keep          # leave the stack running afterwards (combinable with --deploy)
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP=0
DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --deploy) DEPLOY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
PROJECT="wal_smoke_$$"
PORT_HTTPS="${SMOKE_HTTPS_PORT:-28443}"
PORT_HTTP="${SMOKE_HTTP_PORT:-28080}"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/smoke.env"
[[ $DEPLOY -eq 1 ]] && ENV_FILE="$WORK/.env"
JAR="$WORK/cookies.txt"
BASE="https://localhost:${PORT_HTTPS}"
PASS=0
FAIL=0

ok() { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
dc() {
  if [[ $DEPLOY -eq 1 ]]; then
    docker compose --project-directory "$WORK" -f "$WORK/docker-compose.yml" -p "$PROJECT" "$@"
  else
    WAL_ENV_FILE="$ENV_FILE" docker compose --env-file "$ENV_FILE" -p "$PROJECT" "$@"
  fi
}

cleanup() {
  if [[ $KEEP -eq 0 ]]; then
    echo "== tearing down"
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
  else
    echo "== stack left running: project=$PROJECT url=$BASE env=$ENV_FILE"
  fi
}
trap cleanup EXIT

echo "== generating isolated config"
if [[ $DEPLOY -eq 1 ]]; then
  # Exactly the files the README tells users to download, in an otherwise empty directory.
  cp deploy/docker-compose.yml chromium/seccomp-chromium.json scripts/setup.sh "$WORK/"
  (cd "$WORK" && bash setup.sh --site localhost --https-port "$PORT_HTTPS" --http-port "$PORT_HTTP" --force >/dev/null)
  echo "WAL_VERSION=smoke" >>"$ENV_FILE"
  echo "== building images tagged like the published ones"
  docker build -q -t ghcr.io/revocx35/wa_logger-app:smoke . >/dev/null
  docker build -q -t ghcr.io/revocx35/wa_logger-chromium:smoke chromium >/dev/null
  docker build -q -t ghcr.io/revocx35/wa_logger-caddy:smoke caddy >/dev/null
else
  scripts/setup.sh --site localhost --https-port "$PORT_HTTPS" --http-port "$PORT_HTTP" --env-file "$ENV_FILE" --force >/dev/null
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

echo "== starting ($PROJECT)"
if [[ $DEPLOY -eq 1 ]]; then
  dc up -d --pull never --wait --wait-timeout 300 >/dev/null
else
  dc up -d --build --wait --wait-timeout 300 >/dev/null
fi

C=(curl -sk --max-time 15 -c "$JAR" -b "$JAR")

echo "== checks"
[[ "$("${C[@]}" -o /dev/null -w '%{http_code}' "$BASE/healthz")" == "200" ]] && ok "health endpoint via Caddy/TLS" || bad "health endpoint"

HDRS="$("${C[@]}" -D - -o /dev/null "$BASE/api/state")"
for h in "content-security-policy: default-src 'self'" "strict-transport-security" "x-content-type-options: nosniff" "x-frame-options: deny" "referrer-policy: no-referrer" "cache-control: no-store"; do
  grep -qi "^$h" <<<"$HDRS" && ok "header: $h" || bad "missing header: $h"
done
grep -qi '^server:' <<<"$HDRS" && bad "Server header leaks" || ok "no Server header"

CODE="$("${C[@]}" -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  -d "{\"setupToken\":\"$SETUP_TOKEN\",\"username\":\"owner\",\"password\":\"correct-horse-battery-staple\"}" "$BASE/api/auth/signup")"
[[ "$CODE" == "403" ]] && ok "cross-origin signup rejected" || bad "cross-origin signup got $CODE"

CODE="$("${C[@]}" -o /dev/null -w '%{http_code}' -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' \
  -d '{"setupToken":"wrong-token-wrong-token","username":"owner","password":"correct-horse-battery-staple"}' "$BASE/api/auth/signup")"
[[ "$CODE" == "401" ]] && ok "signup with wrong setup token rejected" || bad "wrong setup token got $CODE"

SIGNUP_HDRS="$("${C[@]}" -D - -o "$WORK/signup.json" -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' \
  -d "{\"setupToken\":\"$SETUP_TOKEN\",\"username\":\"owner\",\"password\":\"correct-horse-battery-staple\"}" "$BASE/api/auth/signup")"
grep -q '"recoveryKey"' "$WORK/signup.json" && ok "signup returns a recovery key" || bad "signup failed: $(cat "$WORK/signup.json")"
COOKIE_LINE="$(grep -i '^set-cookie:' <<<"$SIGNUP_HDRS" || true)"
for f in "__Host-wal_session=" "HttpOnly" "Secure" "SameSite=Strict"; do
  grep -qi "$f" <<<"$COOKIE_LINE" && ok "cookie flag: $f" || bad "cookie flag missing: $f"
done

CODE="$("${C[@]}" -o /dev/null -w '%{http_code}' -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' -d '{}' "$BASE/api/auth/logout")"
[[ "$CODE" == "403" ]] && ok "state change without CSRF token rejected" || bad "missing CSRF got $CODE"

STATE=""
for _ in $(seq 1 60); do
  STATE="$("${C[@]}" "$BASE/api/wa/status" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')"
  [[ "$STATE" == "qr" || "$STATE" == "ready" ]] && break
  sleep 3
done
if [[ "$STATE" == "qr" || "$STATE" == "ready" ]]; then
  ok "WhatsApp Web loaded in Chromium (state=$STATE)"
else
  bad "WhatsApp state stuck at '$STATE'"
  "${C[@]}" "$BASE/api/wa/status"; echo
  dc logs --tail 40 app chromium 2>&1 | grep -vE 'healthz|incoming request|request completed' | tail -30
fi

timeout 8 curl -sk --http1.1 -N -b "$JAR" -H "Origin: $PUBLIC_ORIGIN" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/api/vnc" -o "$WORK/ws.bin" || true
grep -aq 'RFB 003.00' "$WORK/ws.bin" && ok "VNC bridge answers with an RFB handshake" || bad "no RFB handshake over /api/vnc"

CODE="$(timeout 8 curl -sk --http1.1 -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Origin: https://evil.example' -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/api/vnc" || true)"
[[ "$CODE" == "403" ]] && ok "cross-origin VNC WebSocket rejected" || bad "cross-origin VNC got $CODE"

CODE="$(timeout 8 curl -sk --http1.1 -o /dev/null -w '%{http_code}' -H "Origin: $PUBLIC_ORIGIN" -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/api/vnc" || true)"
[[ "$CODE" == "401" ]] && ok "anonymous VNC WebSocket rejected" || bad "anonymous VNC got $CODE"

EGRESS="$(dc exec -T app node -e "fetch('https://web.whatsapp.com',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('open')).catch(()=>console.log('blocked'))" 2>/dev/null || echo error)"
[[ "$EGRESS" == "blocked" ]] && ok "app container has no internet access" || bad "app container egress: $EGRESS"

SANDBOX="$(dc exec -T chromium bash -c 'for p in /proc/[0-9]*; do if grep -q -- "--type=renderer" $p/cmdline 2>/dev/null; then readlink $p/ns/pid; break; fi; done; readlink /proc/1/ns/pid' 2>/dev/null | sort -u | wc -l)"
[[ "$SANDBOX" == "2" ]] && ok "Chromium renderers run in a separate PID namespace (sandbox on)" || bad "Chromium sandbox check inconclusive"

echo "== result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
