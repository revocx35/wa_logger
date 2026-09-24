#!/usr/bin/env bash
# Creates .env with strong random secrets for wa_logger.
#
#   scripts/setup.sh                                   # interactive
#   scripts/setup.sh --site 192.168.1.50               # LAN / IP address (Caddy internal CA)
#   scripts/setup.sh --site wa.example.com --email me@example.com   # public domain (Let's Encrypt)
#   options: --https-port 443 --http-port 80 --env-file .env --force
set -euo pipefail
cd "$(dirname "$0")/.."

SITE="" EMAIL="" HTTPS_PORT="443" HTTP_PORT="80" ENV_FILE=".env" FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -f "$ENV_FILE" && $FORCE -ne 1 ]]; then
  echo "$ENV_FILE already exists. Refusing to overwrite (it holds your SETUP_TOKEN and VNC password)." >&2
  echo "Delete it or pass --force if you really want new secrets." >&2
  exit 1
fi

rand() { # $1 = length, alphanumeric (head closing the pipe early is expected, hence +pipefail)
  ( set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" )
}

default_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true
}

if [[ -z "$SITE" ]]; then
  guess="$(default_ip)"
  read -r -p "Address you will open wa_logger at (domain or IP) [${guess:-localhost}]: " SITE
  SITE="${SITE:-${guess:-localhost}}"
fi
SITE="${SITE#http://}"; SITE="${SITE#https://}"; SITE="${SITE%%/*}"
if [[ ! "$SITE" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid site address: $SITE" >&2; exit 2
fi

is_ip=0
[[ "$SITE" =~ ^[0-9]+(\.[0-9]+){3}$ || "$SITE" == "localhost" || "$SITE" != *.* ]] && is_ip=1

if [[ $is_ip -eq 0 && -z "$EMAIL" && -t 0 ]]; then
  read -r -p "E-mail for Let's Encrypt (leave empty to use Caddy's internal CA): " EMAIL
fi
if [[ -n "$EMAIL" ]]; then
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "invalid e-mail" >&2; exit 2; }
  CADDY_TLS="$EMAIL"
else
  CADDY_TLS="internal"
fi

[[ "$HTTPS_PORT" =~ ^[0-9]{1,5}$ && "$HTTP_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "invalid port" >&2; exit 2; }
ORIGIN="https://${SITE}"
[[ "$HTTPS_PORT" != "443" ]] && ORIGIN="${ORIGIN}:${HTTPS_PORT}"

SETUP_TOKEN="$(rand 32)"
VNC_PASSWORD="$(rand 24)"

umask 077
cat >"$ENV_FILE" <<EOF
# wa_logger configuration — generated $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep this file private (chmod 600).

# --- Network / TLS (used by docker compose + caddy)
SITE_ADDRESS=${SITE}
CADDY_TLS=${CADDY_TLS}
HTTPS_PORT=${HTTPS_PORT}
HTTP_PORT=${HTTP_PORT}
# Exact origin your browser uses; requests from any other origin are rejected.
PUBLIC_ORIGIN=${ORIGIN}

# --- Secrets
# Needed once, on the signup page, to create the owner account.
SETUP_TOKEN=${SETUP_TOKEN}
# Protects the internal VNC server (defense in depth; it is never exposed outside Docker).
VNC_PASSWORD=${VNC_PASSWORD}

# --- Sessions
COOKIE_SECURE=true
SESSION_IDLE_HOURS=8
SESSION_MAX_DAYS=7

# --- Logging behaviour (defaults; most can be changed later in Settings)
MEDIA_MAX_MB=100
HISTORY_PER_CHAT=200
RECONCILE_MINUTES=10
LOG_LEVEL=info
SCREEN=1280x800x24
EOF
chmod 600 "$ENV_FILE"

cat <<EOF
Created $ENV_FILE (mode 600).

  Open:         ${ORIGIN}
  Setup token:  ${SETUP_TOKEN}
                (also stored in $ENV_FILE — you need it once, on the signup page)

Next:
  docker compose up -d --build
EOF
if [[ "$CADDY_TLS" == "internal" ]]; then
  echo
  echo "TLS uses Caddy's internal CA: your browser will warn about the certificate the first time."
  echo "To trust it, export the root cert:  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt"
fi
