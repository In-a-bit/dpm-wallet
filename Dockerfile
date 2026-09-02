# syntax=docker/dockerfile:1
#
# The image, for every environment. There is no dev/prod split here and nothing to pass at build
# time: `@inabit-com/dpm-sdk` is an ordinary registry dependency pinned in package.json like every
# other one, so `npm ci` from the committed lockfile fully determines what ships. Moving to a new
# SDK release is a package.json + package-lock.json change, reviewed and committed like any other
# dependency bump.
#
# (This used to be two files. Dockerfile.dev existed only to compile a `file:../dpm-sdk` sibling
# checkout into the image; once the SDK became a published package the two were identical.)
#
# The dev and production *stacks* still differ, but only in how they are operated — published
# ports, defaulted passwords, image tags — which lives in docker-compose.yml and
# docker-compose.prod.yml. Both build this file, so what runs in production is what was tested
# locally.
#
# `docker build .` works from a clean clone with nothing beside it.
#
# Listens on 0.0.0.0:$PORT (8090 by default); probe GET /v1/health. Every table lives in the
# Postgres database DATABASE_URL names; the only thing on the /data volume is the plaintext API
# key pair backup.
#
# Starting the container migrates the database first (see CMD). That step lives here rather than
# in the service, so it is visible in the image and can be skipped by overriding the command —
# `docker run … node dist/main` starts without touching the schema. Under compose the `migrate`
# service does it instead, and the command is overridden there.

ARG NODE_VERSION=22

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# node:22-alpine bundles npm 10, whose hoisting is wrong for this dependency graph: two packages
# in the SDK's tree want incompatible date-fns ranges (@base-ui/react ^4, @metamask/sdk ^2.29), and
# npm 10 writes a lockfile that hoists 2.30 to the root and never places a 4.x — a tree its own
# `npm ci` then rejects as out of sync. npm 11 nests the second copy correctly. The committed
# lockfile is generated with npm 11, so the build has to use it too; see `engines.npm`.
RUN npm i -g npm@11

COPY package.json package-lock.json ./

# `npm ci`, not `npm install`: install exactly the tree the committed lockfile describes, so the
# image cannot quietly pick up a newer release than the one that was reviewed.
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
# Matches the /data mount both compose files declare. The default in src/config.ts is the same,
# but a developer .env carrying a host-relative DATA_DIR would otherwise follow the source into
# the container and land on /app, which this user cannot write to.
ENV DATA_DIR=/data

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# /data is created and given to the service user here, but deliberately NOT declared as a VOLUME.
#
# The declaration would be a no-op where it looks useful — both compose files mount
# `dpm-wallet-data:/data` over it, and an explicit mount always wins — while still firing on every
# *other* container built from this image. Above all the `migrate` service, which shares the image,
# declares no volumes of its own and never touches DATA_DIR: it was being handed a fresh anonymous
# volume on every recreate, each one orphaned under /var/lib/docker and invisible to `docker ps`.
#
# The one file that lands here is a plaintext API key pair (src/vault/api-key-pair-plaintext-backup.ts,
# mode 0600), which is the last thing that should be scattered across dangling volumes nobody knows
# to prune. A missing mount should also fail where someone notices, rather than appear to persist.
#
# So: mount /data explicitly in whatever actually needs it. `mkdir`+`chown` below is what makes the
# path writable; VOLUME was never doing that work.
RUN addgroup -S dpm-wallet && adduser -S dpm-wallet -G dpm-wallet \
    && mkdir -p /data && chown dpm-wallet:dpm-wallet /data

USER dpm-wallet

EXPOSE 8090

ENTRYPOINT ["/sbin/tini", "--"]
# Migrate, then hand the process over to the service. `exec` matters: without it the shell stays
# as tini's child and the service never sees SIGTERM, which would cost the 25s drain on shutdown.
# `&&` matters too — a failed migration must stop the boot rather than start against a stale schema.
CMD ["sh", "-c", "node dist/db/migrate-cli && exec node dist/main"]
