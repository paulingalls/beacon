# Phase 1: Foundation

## Relevant Sections

- `CLAUDE.md` → Repo Structure, Tech Stack & Conventions, Build & Development
- `REQUIREMENTS.md` → §4.1 Tables, §4.2 Migrations, §10 Configuration Reference (`postgres`, `maxConnections`)

## Goal

Set up the monorepo, establish the workspace structure, create the Postgres connection layer, build the migration runner, and apply the initial schema. This phase produces no user-facing functionality — it lays the groundwork everything else builds on.

---

## Milestones

### 1.1 — Repository & Workspace Setup

Initialize the `paulingalls/beacon` repo with Bun workspaces.

**Deliverables:**

- Root `package.json` with Bun workspace config pointing to `packages/*`
- Root `tsconfig.base.json` with strict mode, shared compiler options
- `packages/beacon/package.json` — name `@pi-innovations/beacon`, entry point `src/index.ts`
- `packages/beacon/tsconfig.json` extending the root config
- `packages/beacon-client/package.json` — name `@pi-innovations/beacon-client`, entry point `src/index.ts`
- `packages/beacon-client/tsconfig.json` extending the root config
- Stub `src/index.ts` in both packages (empty exports)
- `.gitignore` (node_modules, dist, .env)
- Copy `CLAUDE.md`, `README.md`, `BEACON_OVERVIEW.md`, `REQUIREMENTS.md`, `MILESTONES.md` into the repo root
- Copy `phases/` directory into the repo root
- Verify: `bun install` succeeds, `bun test` runs (no tests yet, but no errors)

### 1.2 — Postgres Connection Layer

Create the database adapter using `postgres.js`.

**Deliverables:**

- `packages/beacon/src/storage/db.ts` — exports a `createDb(config)` function that returns a `postgres.Sql` instance
- Config accepts `connectionString` and `maxConnections` (default 10) per `REQUIREMENTS.md` §10
- Connection error handling: log warning on failure, do not throw (per `REQUIREMENTS.md` §1.3 Failure Isolation)
- Export a `closeDb()` function for graceful shutdown
- Install `postgres` as a dependency in `packages/beacon`

### 1.3 — Migration Runner

Build the migration system described in `REQUIREMENTS.md` §4.2.

**Deliverables:**

- `packages/beacon/src/storage/migrations/` directory
- `packages/beacon/src/storage/migrate.ts` — migration runner that:
  - Creates `beacon_migrations` table if it doesn't exist
  - Scans the migrations directory for `.sql` files
  - Compares against `beacon_migrations` to find unapplied files
  - Applies unapplied migrations in filename order within a transaction
  - Records each applied migration in `beacon_migrations`
- `bun run migrate` script in root `package.json` that invokes the runner
- Reads `DATABASE_URL` from environment

### 1.4 — Initial Schema Migration

Create the first migration file with the core tables from `REQUIREMENTS.md` §4.1.

**Deliverables:**

- `packages/beacon/src/storage/migrations/001_initial_schema.sql` containing:
  - `beacon_events` table with all columns and indexes
  - `beacon_short_links` table with all columns and indexes
  - `beacon_meta` table with primary key
  - `beacon_migrations` table (idempotent — `CREATE TABLE IF NOT EXISTS`)
- Verify: `bun run migrate` applies cleanly to an empty Postgres database
- Verify: running migrate a second time is a no-op

### 1.5 — Foundation Tests

**Deliverables:**

- Integration test: migration runner applies to a clean database, is idempotent
- Integration test: `createDb` connects successfully, returns a working client
- Integration test: `createDb` with an invalid connection string logs a warning and does not throw
- Test runner configured in root `package.json`: `bun test` and `bun test --filter beacon`
- All tests pass

---

## Exit Criteria

- Monorepo structure matches `CLAUDE.md` → Repo Structure
- `bun install`, `bun test`, and `bun run migrate` all succeed
- Schema is applied to Postgres with all tables and indexes from `REQUIREMENTS.md` §4.1
- Postgres connection layer handles failures gracefully per `REQUIREMENTS.md` §1.3
