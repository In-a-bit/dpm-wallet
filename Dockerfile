# syntax=docker/dockerfile:1
#
# Single image an operator runs inside their own infrastructure. Listens on 0.0.0.0:8090;
# probe GET /v1/health. Every table lives in the Postgres database DATABASE_URL names; the only
# thing on the /data volume is the plaintext API key pair backup.
#
# Starting the container migrates the database first (see CMD). That step lives here rather than
# in the service, so it is visible in the image and can be skipped by overriding the command —
# `docker run … node dist/main` starts without touching the schema.

ARG NODE_VERSION=22

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# nest-cli.json drives the build, selecting tsconfig.build.json. The migrations need no asset
# copying: they are TypeScript classes, so the ordinary compile emits them into dist.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/

RUN npm run build

# Drop the dev dependencies from the tree the runtime stage inherits.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN addgroup -S dpm-wallet && adduser -S dpm-wallet -G dpm-wallet \
    && mkdir -p /data && chown dpm-wallet:dpm-wallet /data

USER dpm-wallet

VOLUME ["/data"]
EXPOSE 8090

ENTRYPOINT ["/sbin/tini", "--"]
# Migrate, then hand the process over to the service. `exec` matters: without it the shell stays
# as tini's child and the service never sees SIGTERM, which would cost the 25s drain on shutdown.
# `&&` matters too — a failed migration must stop the boot rather than start against a stale schema.
CMD ["sh", "-c", "node dist/db/migrate-cli && exec node dist/main"]
