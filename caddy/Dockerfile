# wa_logger reverse proxy: official Caddy with the wa_logger Caddyfile baked in (so the container can
# run with a read-only root filesystem and no config files need to be downloaded).
# Plain-HTTP variant (behind your own TLS reverse proxy): CADDY_CONFIG=Caddyfile.http.
# To customise, mount your own file over /etc/caddy/Caddyfile.
FROM caddy:2.11-alpine
COPY Caddyfile Caddyfile.http /etc/caddy/

