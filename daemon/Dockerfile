# Build context is the MONOREPO ROOT (the daemon depends on the local
# obsidian-now-datecore workspace):  docker build -f daemon/Dockerfile .

# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/datecore/package.json ./packages/datecore/
COPY daemon/package.json ./daemon/
RUN npm ci
COPY packages/datecore ./packages/datecore
COPY daemon ./daemon
# Build the shared package, then bundle the daemon into self-contained .cjs
# files (datecore + luxon + dotenv are inlined -- no node_modules at runtime).
RUN npm run build -w obsidian-now-datecore \
	&& npm run bundle -w obsidian-remind

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV CONFIG=/config/config.json
COPY --from=build /app/daemon/dist ./dist

RUN addgroup -S app && adduser -S app -G app \
	&& mkdir -p /config /state && chown -R app:app /state
USER app
VOLUME ["/config", "/state"]

# Liveness: the daemon touches /state/heartbeat every tick.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
	CMD ["node", "dist/healthcheck.cjs"]

CMD ["node", "dist/index.cjs"]
