# syntax=docker/dockerfile:1
# Build on the target platform: canvas/resvg ship platform-specific binaries.
FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
    && node scripts/smoke-provider-runtime.mjs \
    && node scripts/build-server.mjs \
    && node scripts/smoke-server.mjs

FROM node:26-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates chromium tini fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LH_DATA_DIR=/var/lib/learnharness/data \
    LH_AUTH_FILE=/var/lib/learnharness/auth.json \
    CHROME_PATH=/usr/bin/chromium \
    XDG_CACHE_HOME=/tmp/learnharness-cache \
    XDG_CONFIG_HOME=/tmp/learnharness-config
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --chown=node:node scripts/smoke-container.mjs ./scripts/smoke-container.mjs
COPY --chown=node:node tests/fixtures/sample-3page.pdf ./scripts/fixtures/sample-3page.pdf
COPY --chmod=755 scripts/container-entrypoint.sh /usr/local/bin/learnharness-entrypoint
RUN mkdir -p /var/lib/learnharness/data \
    && chown -R node:node /var/lib/learnharness
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/learnharness-entrypoint"]
CMD ["node", "server.js"]
