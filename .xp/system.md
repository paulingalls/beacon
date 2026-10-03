# System Context

**Product**: Beacon is PI Innovations' privacy-first, cookie-free analytics stack,
shared by every PI product. Products emit events over an authenticated `POST /events`
boundary using the published HTTP-emit SDK (`@pi-innovations/beacon-sdk`) or the mobile/web
client (`@pi-innovations/beacon-client`). One private deployed server (`apps/server`) is the
single writer and the only holder of DB credentials. It writes everything to one Postgres,
with `product_id` as a first-class dimension, and serves an agent-friendly query API, an
admin dashboard and a URL shortener. Production runs at beacon.vodshorter.com.

**Stack**: TypeScript (strict) on Bun 1.3+; Hono; Postgres 16 via `postgres` (postgres.js,
tagged templates, no ORM); Bun workspaces; `bun:test`; Playwright for the browser surface;
Biome for lint/format; lefthook git hooks; GitHub Actions CI and deploy.

**Surfaces & acceptance**:
- HTTP (ingest, `/analytics/*` query API, shortener redirects): bun:test suites that serve
  the app over a real socket with default request capture enabled for each changed endpoint.
  Fixtures that exclude an API prefix supplement, but cannot replace, that default-path check. See `test/acceptance/http.acceptance.test.ts`, `shortener.acceptance.test.ts`
  and the `*.roundtrip.acceptance.test.ts` suites against live Postgres.
- Browser (admin dashboard): Playwright `test/acceptance/dashboard/*.e2e.ts` against
  `serve.ts`, run with `bun run test:e2e`.
- SDK (both published packages): `test/acceptance/sdk/*`, plus
  `test/acceptance/ci/release-artifacts.roundtrip.test.ts`, which subtree-splits each package
  and imports it by name from a fresh consumer.
- Automation (CI workflows, `scripts/deploy.sh`, migrations): `test/acceptance/ci/*`,
  `test/acceptance/deploy/rollback.test.ts`, `apps/server/src/storage/migrate.test.ts`.
- CLI and Message-event: none.

**Layout**:
- `apps/server/src/` — the server: `createBeacon.ts`, `api/`, `query/`, `storage/` (plus
  `migrations/`), `dashboard/`, `shortener/`, `events/buffer.ts`
- `packages/beacon/src/` — the published emit SDK (`httpBeacon.ts`, `index.ts` locked surface)
- `packages/beacon-client/src/` — the client SDK (`core/`, `platform/`, `context/`)
- `test/acceptance/` — surface-driving acceptance suites; `test/setup/ensure-test-db.ts` preload
- `docs/REQUIREMENTS.md` (the contract), `docs/MILESTONES.md`, `docs/phases/`
- `lefthook.yml`, `package.json` scripts `test:fast|story|slow|e2e`, `.github/workflows/`

**Conventions**:
- Beacon never stores identifiers client-side: no cookies, no localStorage or other
  browser/device storage. The one exception is the identifier-free outbound event queue.
- The single-writer boundary is physical: the SDK packages must never import postgres or
  hold DB credentials.
- Never block a request on logging. Events are buffered and flushed asynchronously.
- Raw IPs are never stored long-term. Every query API endpoint sits behind auth.
- Migrations are additive-only plain SQL, guarded by the committed checksum manifest.
- Keep dependencies minimal and never add an analytics dependency.
- Run tests from the repo root so the DB preload is picked up. Destructive suites must
  run sequentially per database, or use a distinct database for each concurrent process.
- Register any new subprocess or seconds-scale suite in BOTH `test:story`'s ignore list
  and `test:slow`, so the per-commit tiers stay fast.
- Run `bun run format` before committing (Biome import-sort blocks the hook).

Keep each of the two worktree labels below and its value on one colon-delimited
line. A Markdown heading with the value on the next line is unreadable.

**Worktree bootstrap**: `bun install --frozen-lockfile`

**Worktree teardown**: `docker compose down`
Same value grammar as bootstrap: ONE backticked command, or "none". It runs in
the checkout before removal; unlike bootstrap, failure is reported and removal
continues. `config.yml`'s `teardown_timeout` caps it.
