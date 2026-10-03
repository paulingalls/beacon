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

COPY . .

EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`, {signal: AbortSignal.timeout(2000)}); if (!r.ok || (await r.json()).status !== "ok") process.exit(1);'
CMD ["bun", "run", "apps/server/src/server.ts"]
