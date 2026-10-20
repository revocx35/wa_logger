#!/bin/bash
# wa_logger chromium container entrypoint: validates the environment, finds the address to listen on and hands over to
# the manager, which starts one Xvfb + Chromium + x11vnc per user on demand (see manager/).
set -Eeuo pipefail

log() { printf '[chromium-entrypoint] %s\n' "$*" >&2; }

: "${CONTROL_SECRET:?CONTROL_SECRET must be set}"
SCREEN="${SCREEN:-1280x800x24}"
if [[ ! "$SCREEN" =~ ^([0-9]{3,4})x([0-9]{3,4})x(16|24)$ ]]; then
  log "invalid SCREEN '$SCREEN' (expected e.g. 1280x800x24)"; exit 1
fi
MANAGER_PORT="${MANAGER_PORT:-9223}"
BACKEND_PEER="${BACKEND_PEER:-app}"

umask 077
# The profile volume's root must be traversable by every user's browser but listable by none; each user's directory
# below it is 0700 and owned by that user. (Tenant 1's profile keeps its owner from the single-user releases.)
chown root:root /data
chmod 0711 /data
mkdir -p /run/wal /home/chrome /tmp/.X11-unix
chmod 0711 /run/wal
chmod 0711 /home/chrome
chmod 1777 /tmp/.X11-unix

# Determine which address the manager listens on. By default: our own address on the network shared with the app (so
# nothing listens on the egress network). BIND_ADDRESS overrides.
resolve_bind_ip() {
  if [[ -n "${BIND_ADDRESS:-}" ]]; then echo "$BIND_ADDRESS"; return; fi
  local peer_ip route src
  while true; do
    peer_ip="$(getent ahostsv4 "$BACKEND_PEER" 2>/dev/null | awk 'NR==1{print $1}')" || true
    if [[ -n "$peer_ip" ]]; then
      route="$(ip -4 route get "$peer_ip" 2>/dev/null)" || true
      src="$(sed -n 's/.* src \([0-9.]*\).*/\1/p' <<<"$route")"
      # The app shares a network with us, so its address is on-link. A route "via" a gateway means the name
      # resolved somewhere else (before the app container exists, Docker's DNS asks the host's resolver, and a
      # search domain can turn "app" into a public address): binding there would listen on the egress network.
      if [[ -n "$src" && "$route" != *" via "* ]]; then echo "$src"; return; fi
    fi
    sleep 2
  done
}

ip="$(resolve_bind_ip)"
log "manager listening on ${ip}:${MANAGER_PORT} (screen ${SCREEN})"
export LISTEN_ADDR="${ip}:${MANAGER_PORT}"
exec /usr/local/bin/wal-chromium-manager
