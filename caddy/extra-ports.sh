#!/bin/sh
# Writes one Caddy site per port of EXTRA_PORTS ("8101-8110", "8101,8105-8107"…) to /tmp/extra-ports.caddy, which the
# Caddyfiles import, then starts Caddy. Each port is forwarded to the same port of the app container: the app decides by
# the port a connection arrived on which users may sign in (the admin opens ports in the web UI).
#   CADDY_CONFIG=Caddyfile.http  -> plain HTTP on that port (your own TLS proxy in front)
#   CADDY_CONFIG=Caddyfile       -> HTTPS on that port with the site's own certificate
set -eu
OUT=/tmp/extra-ports.caddy
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
