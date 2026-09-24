# wa_logger — Chromium container running WhatsApp Web (headful under Xvfb).
# Exposes (on the internal backend network only):
#   9223/tcp  Chrome DevTools Protocol (socat relay → 127.0.0.1:9222)
#   5900/tcp  x11vnc (password protected; reached only through the app's authenticated bridge)
FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11vnc \
      socat iproute2 curl ca-certificates tini \
      fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Managed policy: lock the browser down to WhatsApp Web only.
COPY policies.json /etc/chromium/policies/managed/wa_logger.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0644 /etc/chromium/policies/managed/wa_logger.json \
 && chmod 0755 /usr/local/bin/entrypoint.sh \
 && groupadd -g 10002 chrome \
 && useradd -u 10002 -g 10002 -m -d /home/chrome -s /usr/sbin/nologin chrome \
 && mkdir -p /data \
 && chown 10002:10002 /data \
 && chmod 0700 /data

USER 10002:10002
ENV HOME=/home/chrome \
    DISPLAY=:99 \
    DBUS_SESSION_BUS_ADDRESS=disabled: \
    SCREEN=1280x800x24

VOLUME ["/data"]
EXPOSE 9223 5900
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:9222/json/version || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
