# syntax=docker/dockerfile:1
#
# Single image an operator runs inside their own infrastructure. Listens on 0.0.0.0:8090;
# probe GET /v1/health. The SQLite database lives on the /data volume, never in the image.

ARG NODE_VERSION=22

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

# better-sqlite3 ships prebuilt binaries for glibc only, so on Alpine's musl its native
# addon is always compiled from source. The toolchain is required here, not optional.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ scripts/
COPY src/ src/

RUN npm run build

# Drop the dev dependencies from the tree the runtime stage inherits. Pruning rather than
# reinstalling keeps the addon that was just compiled, so it is built exactly once and the
# runtime image needs no compiler at all.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
# Same Node major and same Alpine base as the builder, so the compiled addon's ABI matches.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN addgroup -S dpm-wallet && adduser -S dpm-wallet -G dpm-wallet \
    && mkdir -p /data && chown dpm-wallet:dpm-wallet /data

USER dpm-wallet

VOLUME ["/data"]
EXPOSE 8090

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
