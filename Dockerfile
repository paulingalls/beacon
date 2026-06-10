# Container image for the Beacon host app (apps/server) — sprint-012 / Milestone 4.
# DigitalOcean App Platform buildpacks don't ship Bun, so we build from oven/bun and run
# the TypeScript entry directly (Bun executes .ts; the workspace has no build step).
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# Copy the lockfile + every workspace manifest first so `bun install` is cached on a
# dependency-only layer and re-runs only when a manifest changes.
COPY package.json bun.lock ./
COPY packages/beacon/package.json packages/beacon/
COPY packages/beacon-client/package.json packages/beacon-client/
COPY apps/server/package.json apps/server/

# --production drops dev-only deps (biome/playwright/lefthook/typescript) while keeping the
# workspace runtime deps (beacon's hono + postgres). --ignore-scripts skips the root
# `prepare: lefthook install`, which would fail in this git-less image. --frozen-lockfile
# pins to bun.lock so the image matches local/CI installs exactly.
RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy the source (bun runs the .ts directly — no compile step).
COPY . .

# apps/server reads PORT (default 8080); App Platform sets PORT to the service http_port.
EXPOSE 8080
CMD ["bun", "run", "apps/server/src/server.ts"]
