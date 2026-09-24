# wa_logger reverse proxy: official Caddy with the wa_logger Caddyfile baked in (so the container can
# run with a read-only root filesystem and no config files need to be downloaded).
# To customise, mount your own file over /etc/caddy/Caddyfile.
FROM caddy:2.11-alpine
COPY Caddyfile /etc/caddy/Caddyfile

