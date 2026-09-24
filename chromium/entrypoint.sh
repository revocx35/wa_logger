#!/bin/bash
# wa_logger chromium supervisor: Xvfb + Chromium + x11vnc + CDP relay, each restarted if it dies.
set -Eeuo pipefail

log() { printf '[chromium-entrypoint] %s\n' "$*" >&2; }

: "${VNC_PASSWORD:?VNC_PASSWORD must be set}"
SCREEN="${SCREEN:-1280x800x24}"
if [[ ! "$SCREEN" =~ ^([0-9]{3,4})x([0-9]{3,4})x(16|24)$ ]]; then
  log "invalid SCREEN '$SCREEN' (expected e.g. 1280x800x24)"; exit 1
fi
WIDTH="${BASH_REMATCH[1]}"; HEIGHT="${BASH_REMATCH[2]}"
CDP_INTERNAL_PORT=9222
CDP_PORT="${CDP_PORT:-9223}"
VNC_PORT="${VNC_PORT:-5900}"
BACKEND_PEER="${BACKEND_PEER:-app}"
PROFILE_DIR=/data/profile

umask 077
mkdir -p "$PROFILE_DIR" /tmp/vnc
# A crash can leave the profile locked; only this container ever uses the profile.
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket "$PROFILE_DIR"/SingletonCookie

# VNC classic auth (only the first 8 characters are significant). Defense in depth only:
# the port is reachable solely on the internal backend network, via the app's authenticated bridge.
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc/passwd >/dev/null 2>&1
unset VNC_PASSWORD

# Determine which address to bind the network-facing relays to. By default: our own address on the
# network shared with the app (so nothing listens on the egress network). BIND_ADDRESS overrides.
resolve_bind_ip() {
  if [[ -n "${BIND_ADDRESS:-}" ]]; then echo "$BIND_ADDRESS"; return; fi
  local peer_ip src
  while true; do
    peer_ip="$(getent ahostsv4 "$BACKEND_PEER" 2>/dev/null | awk 'NR==1{print $1}')" || true
    if [[ -n "$peer_ip" ]]; then
      src="$(ip -4 route get "$peer_ip" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')" || true
      if [[ -n "$src" ]]; then echo "$src"; return; fi
    fi
    sleep 2
  done
}

PIDS=()
STOPPING=0

supervise() { # name, command...
  local name="$1"; shift
  (
    trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
    while true; do
      "$@" &
      child=$!
      wait "$child" && rc=0 || rc=$?
      log "$name exited (code $rc); restarting in 2s"
      sleep 2
    done
  ) &
  PIDS+=("$!")
}

start_xvfb() {
  Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp -dpi 96 +extension RANDR >/dev/null 2>&1
}

wait_for_display() {
  for _ in $(seq 1 100); do
    [[ -S /tmp/.X11-unix/X99 ]] && return 0
    sleep 0.1
  done
  log "Xvfb did not come up"; return 1
}

start_chromium() {
  wait_for_display
  rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket "$PROFILE_DIR"/SingletonCookie
  local extra=()
  if [[ "${CHROMIUM_NO_SANDBOX:-0}" == "1" ]]; then
    log "WARNING: CHROMIUM_NO_SANDBOX=1 — Chromium sandbox DISABLED. Fix the seccomp profile instead."
    extra+=(--no-sandbox)
  fi
  local out=/dev/null
  [[ "${CHROMIUM_DEBUG:-0}" == "1" ]] && out=/dev/stderr
  chromium \
    --user-data-dir="$PROFILE_DIR" \
    --remote-debugging-port="$CDP_INTERNAL_PORT" \
    --kiosk \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --disable-features=Translate,MediaRouter,DialMediaRouteProvider \
    --disable-component-update \
    --noerrdialogs \
    --hide-crash-restore-bubble \
    --disable-session-crashed-bubble \
    --lang=en-US \
    --force-device-scale-factor=1 \
    --window-position=0,0 \
    --window-size="${WIDTH},${HEIGHT}" \
    "${extra[@]}" \
    about:blank >"$out" 2>&1
}

start_vnc() {
  wait_for_display
  local ip; ip="$(resolve_bind_ip)"
  log "x11vnc listening on ${ip}:${VNC_PORT}"
  x11vnc -display :99 -rfbport "$VNC_PORT" -listen "$ip" -noipv6 -rfbauth /tmp/vnc/passwd \
    -forever -shared -noxdamage -nowf -quiet >/dev/null 2>&1
}

start_cdp_relay() {
  local ip; ip="$(resolve_bind_ip)"
  log "CDP relay listening on ${ip}:${CDP_PORT}"
  socat "TCP-LISTEN:${CDP_PORT},bind=${ip},fork,reuseaddr" "TCP:127.0.0.1:${CDP_INTERNAL_PORT}"
}

shutdown() {
  [[ $STOPPING == 1 ]] && return
  STOPPING=1
  log "stopping"
  # Stop Chromium first so it can flush the profile (WhatsApp session, IndexedDB).
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  wait || true
  exit 0
}
trap shutdown TERM INT

supervise xvfb start_xvfb
supervise chromium start_chromium
supervise x11vnc start_vnc
supervise cdp-relay start_cdp_relay

log "started (screen ${WIDTH}x${HEIGHT})"
wait
