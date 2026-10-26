#!/bin/sh
# Writes one Caddy site per port of EXTRA_PORTS ("8101-8110", "8101,8105-8107"…) to /tmp/extra-ports.caddy, which the
# Caddyfiles import, then starts Caddy. Each port is forwarded to the same port of the app container: the app decides by
# the port a connection arrived on which users may sign in (the admin opens ports in the web UI).
#   CADDY_CONFIG=Caddyfile.http  -> plain HTTP on that port (your own TLS proxy in front)
#   CADDY_CONFIG=Caddyfile       -> HTTPS on that port with the site's own certificate
#
# API_TLS_PORT (optional, e.g. 8443): an extra HTTPS-only listener that forwards nothing but /api/v1/* (the bearer-token API
# for other apps such as Poker Balance) to the default app port; every other path is 404. It uses a long-lived self-signed
# certificate stored in /data/api-tls (generated once), so a client can pin its SHA-256 fingerprint, which is printed here.
set -eu
OUT=/tmp/extra-ports.caddy
API_OUT=/tmp/extra-ports-api.caddy
: > "$API_OUT"
case "${API_TLS_PORT:-}" in
  "") ;;
  *[!0-9]*) echo "extra-ports: API_TLS_PORT must be a port number" >&2; exit 1 ;;
  *)
    D=/data/api-tls
    if [ ! -s "$D/cert.pem" ] || [ ! -s "$D/key.pem" ]; then
      mkdir -p "$D"; umask 077
      case "$SITE_ADDRESS" in
        *[!0-9.]*) SAN="DNS:$SITE_ADDRESS" ;;
        *) SAN="IP:$SITE_ADDRESS" ;;
      esac
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
        -subj "/CN=wa_logger api" -addext "subjectAltName=$SAN" -keyout "$D/key.pem" -out "$D/cert.pem" 2>/dev/null
    fi
    echo "extra-ports: API TLS port $API_TLS_PORT, certificate SHA-256 $(openssl x509 -in "$D/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f')"
    printf '%s:%s {\n\ttls %s/cert.pem %s/key.pem\n\timport wal_api\n}\n' "$SITE_ADDRESS" "$API_TLS_PORT" "$D" "$D" > "$API_OUT"
    ;;
esac
: > "$OUT"
case "${EXTRA_PORTS:-}" in
  "") ;;
  *[!0-9,-]*) echo "extra-ports: EXTRA_PORTS may only contain digits, commas and dashes" >&2; exit 1 ;;
  *)
    for part in $(echo "$EXTRA_PORTS" | tr ',' ' '); do
      lo="${part%-*}"; hi="${part#*-}"
      case "$lo$hi" in ""|*[!0-9]*) echo "extra-ports: bad range '$part'" >&2; exit 1 ;; esac
      if [ "$hi" -lt "$lo" ] || [ "$lo" -lt 1 ] || [ "$hi" -gt 65535 ] || [ $((hi - lo)) -gt 200 ]; then
        echo "extra-ports: bad range '$part'" >&2; exit 1
      fi
      p="$lo"
      while [ "$p" -le "$hi" ]; do
        if [ "${CADDY_CONFIG:-Caddyfile}" = "Caddyfile.http" ]; then
          printf ':%s {\n\timport wal_site %s\n}\n' "$p" "$p" >> "$OUT"
        else
          printf '%s:%s {\n\ttls %s\n\timport wal_site %s\n}\n' "$SITE_ADDRESS" "$p" "${CADDY_TLS:-internal}" "$p" >> "$OUT"
        fi
        p=$((p + 1))
      done
    done
    ;;
esac
exec "$@"
