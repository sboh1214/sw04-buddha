# syntax=docker/dockerfile:1
# Three runtime images from one build graph (ADR-0040): `--target api|worker|web`. The install and
# build stages are shared, so a CI run pays for `pnpm install` and the workspace builds once.
# Built for linux/arm64 (Graviton t4g); Apple Silicon builds it natively for local checks:
#   docker buildx build --platform linux/arm64 --target api -t buddha-api:local .
#
# Every native dependency the runtime needs is either pure JS (pg, ioredis) or ships a prebuild in
# the lockfile. One known wrinkle: @msgpackr-extract's linux-arm64 package carries musl binaries
# only, so on this glibc base its optional install script falls back to node-gyp, fails (no
# compiler here) and pnpm prints a WARN — bullmq then uses msgpackr's pure-JS path. Expected.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_store_dir=/pnpm/store
# Pinned to package.json "packageManager"; npm rather than corepack so the version is explicit.
RUN npm install -g pnpm@11.10.0
WORKDIR /app

# ---- manifests: everything `pnpm install --frozen-lockfile` needs to resolve the workspace -------
# All importers in pnpm-lock.yaml must be present, including apps/mobile (manifest only; its Expo
# tree is never installed because it is outside the --filter set).
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/api-client/package.json packages/api-client/
COPY packages/config-ts/package.json packages/config-ts/
COPY packages/config-eslint/package.json packages/config-eslint/

# ---- deps: dev + prod dependencies of the three apps and their workspace deps ----------------------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter 'api...' --filter 'worker...' --filter 'web...'

# ---- build-server: workspace packages + api + worker (and web's workspace deps) ---------------------
# turbo is a ROOT devDependency and the filtered install above does not include the workspace root,
# so pnpm orders the builds itself (topological: shared -> db / api-client -> api / worker).
FROM deps AS build-server
COPY . .
RUN pnpm --filter 'api...' --filter 'worker...' --filter 'web^...' run build

# ---- build-web: separate stage so the api/worker targets never need NEXT_PUBLIC_API_URL -------------
# The public origin is baked into the browser bundle, the /api rewrite destination and the CSP
# (ADR-0017), so the web image must be rebuilt whenever the hostname changes.
FROM build-server AS build-web
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo 'build-arg NEXT_PUBLIC_API_URL is required for the web target' >&2; exit 1; }
RUN pnpm --filter web run build

# ---- prod-deps: production-only node_modules for api + worker ---------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter 'api...' --filter 'worker...'

# ---- server-runtime: shared layout for api and worker ------------------------------------------------
# The pnpm virtual store (node_modules/.pnpm) plus each package's node_modules directory of relative
# symlinks are copied as-is; Docker preserves the links, so `@buddha/db` resolves to packages/db/dist.
FROM ${NODE_IMAGE} AS server-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/package.json packages/shared/
COPY --from=prod-deps /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build-server /app/packages/shared/dist packages/shared/dist
COPY --from=prod-deps /app/packages/db/package.json packages/db/
COPY --from=prod-deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=build-server /app/packages/db/dist packages/db/dist
# drizzle-orm's migrator resolves ../drizzle/ from packages/db/dist (packages/db/src/migrator.ts).
COPY packages/db/drizzle packages/db/drizzle
# The media store (#46): the S3 driver both the api and the worker use.
COPY --from=prod-deps /app/packages/storage/package.json packages/storage/
COPY --from=prod-deps /app/packages/storage/node_modules packages/storage/node_modules
COPY --from=build-server /app/packages/storage/dist packages/storage/dist

FROM server-runtime AS api
COPY --from=prod-deps /app/apps/api/package.json apps/api/
COPY --from=prod-deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=build-server /app/apps/api/dist apps/api/dist
# The deploy bundle rides with the api image; the SSM deploy command unpacks /app/deploy into
# /data/buddha on the host. 01-roles.sql is the unchanged repo file (also used by CI).
COPY deploy/ deploy/
COPY docker/postgres/init/01-roles.sql deploy/postgres-init/01-roles.sql
# MALLOC_MMAP_THRESHOLD_: glibc maps every allocation of 128KiB or more on its own and unmaps it
# when freed — the fixed threshold that stops glibc raising it as it goes. An image conversion's
# buffers are such allocations: without it the api's resident memory kept what each conversion had
# taken (in its 448MiB limit, a few of the costliest conversions in a row were killed for memory)
# and the memory admission, which watches that memory, would hold uploads back for good
# (ADR-0073 9-46; apps/api/src/media/image-memory.test.ts runs its conversions with this value).
ENV API_HOST=0.0.0.0 \
    API_PORT=4000 \
    MALLOC_MMAP_THRESHOLD_=131072
USER node
EXPOSE 4000
# exec form: SIGTERM reaches Nest's shutdown hooks directly (main.ts enableShutdownHooks).
CMD ["node", "apps/api/dist/main.js"]

FROM server-runtime AS worker
COPY --from=prod-deps /app/apps/worker/package.json apps/worker/
COPY --from=prod-deps /app/apps/worker/node_modules apps/worker/node_modules
COPY --from=build-server /app/apps/worker/dist apps/worker/dist
ENV WORKER_HOST=127.0.0.1 \
    WORKER_HEALTH_PORT=4100
USER node
CMD ["node", "apps/worker/dist/main.js"]

# ---- web: Next standalone output only ---------------------------------------------------------------
# apps/web/scripts/copy-standalone.mjs already placed public/ and .next/static inside the standalone
# tree. server.js is run directly with HOSTNAME=0.0.0.0 (ADR-0016); Docker otherwise injects
# HOSTNAME=<container id> and Next would bind that name.
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build-web --chown=node:node /app/apps/web/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
