#!/bin/bash
# wa_logger chromium container entrypoint: validates the environment, finds the address to listen on and hands over to
# the manager, which starts one Xvfb + Chromium + x11vnc per user on demand (see manager/).
set -Eeuo pipefail

log() { printf '[chromium-entrypoint] %s\n' "$*" >&2; }

# CONTROL_SECRET replaced VNC_PASSWORD (older .env files / compose files only have the latter).
CONTROL_SECRET="${CONTROL_SECRET:-${VNC_PASSWORD:-}}"
: "${CONTROL_SECRET:?CONTROL_SECRET must be set}"
export CONTROL_SECRET
unset VNC_PASSWORD
SCREEN="${SCREEN:-1280x800x24}"
if [[ ! "$SCREEN" =~ ^([0-9]{3,4})x([0-9]{3,4})x(16|24)$ ]]; then
  log "invalid SCREEN '$SCREEN' (expected e.g. 1280x800x24)"; exit 1
fi

umask 077
# The profile volume's root must be traversable by every user's browser but listable by none; each user's directory
# below it is 0700 and owned by that user. (Tenant 1's profile keeps its owner from the single-user releases.)
chown root:root /data
chmod 0711 /data
mkdir -p /run/wal /home/chrome /tmp/.X11-unix
chmod 0711 /run/wal
chmod 0711 /home/chrome
chmod 1777 /tmp/.X11-unix

# The manager answers /healthz on loopback straight away and listens on our address on the network shared with the app
# (BACKEND_PEER, default "app") as soon as that network exists. LISTEN_ADDR overrides the address.
log "starting the manager (screen ${SCREEN})"
exec /usr/local/bin/wal-chromium-manager
