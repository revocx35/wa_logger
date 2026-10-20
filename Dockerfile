# wa_logger app image: builds the web UI and the server, runs as an unprivileged user.
# Build context: repository root.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------- web UI
FROM ${NODE_IMAGE} AS web-build
WORKDIR /build
COPY shared ./shared
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

# ---------------------------------------------------------------- server
FROM ${NODE_IMAGE} AS server-build
WORKDIR /build
# Toolchain only for compiling native modules if no prebuilt binary is available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY shared ./shared
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund
COPY server ./server
RUN cd server && npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    WEB_DIR=/app/web \
    DATA_DIR=/data \
    USERS_DIR=/users \
    PORT=8080
WORKDIR /app
# Users: `app` (10001) owns tenant 1's data in /data, as in the single-user releases; `front` (10003) is the gateway.
# Every other tenant runs as uid 10100+<id>, created on demand by the supervisor (no passwd entry needed).
RUN groupadd -g 10001 app \
 && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin app \
 && groupadd -g 10003 front \
 && useradd -u 10003 -g 10003 -M -d /nonexistent -s /usr/sbin/nologin front \
 && mkdir -p /data /users \
 && chown 10001:10001 /data \
 && chmod 0700 /data \
 && chown root:root /users \
 && chmod 0711 /users \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
COPY --from=server-build --chown=root:root /build/server/node_modules ./node_modules
COPY --from=server-build --chown=root:root /build/server/dist ./dist
COPY --from=server-build --chown=root:root /build/server/package.json ./package.json
COPY --from=web-build --chown=root:root /build/web/dist ./web

# Runs as root, but only the supervisor (src/supervisor): it needs CAP_SETUID/SETGID/CHOWN/KILL (and nothing else; compose drops
# every other capability) to start the gateway and one worker per user under their own unix users. See ARCHITECTURE.md §3.
VOLUME ["/data", "/users"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "--disable-proto=delete", "dist/supervisor/main.js"]
