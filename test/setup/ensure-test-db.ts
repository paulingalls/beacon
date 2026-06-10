// Bun test preload (registered in bunfig.toml). Runs ONCE before any test
// module evaluates — so the integration suites' module-load
// `const TEST_DB = process.env.TEST_DATABASE_URL` + `describe.skipIf(!TEST_DB)`
// observe whatever we set here.
//
// Goal: integration tests "just work" without a manual `export TEST_DATABASE_URL`.
//
// Behavior:
//   - TEST_DATABASE_URL already set  -> respect it (CI / explicit override), but
//                                       PROBE it first (verifyExternalDb): an
//                                       expected-but-unreachable DB fails loud here
//                                       rather than as confusing per-suite errors.
//   - BEACON_TEST_DB === 'off'       -> skip bootstrap (the pre-commit hook sets
//                                       this to stay fast and DB-free).
//   - otherwise                      -> `docker compose up -d --wait` (idempotent;
//                                       near-instant when the container is already
//                                       healthy) and point TEST_DATABASE_URL at the
//                                       compose Postgres.
//   - docker missing / compose fails -> warn and leave TEST_DATABASE_URL unset, so
//                                       the integration suites skip gracefully
//                                       exactly as they did before.
//
// The preload does NOT migrate: each integration suite already drops + runs
// migrations in its own beforeAll (see packages/beacon/test/helpers.ts). We only
// guarantee the server is up and reachable.

import { join } from 'node:path';

import postgres from 'postgres';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// Strip userinfo (user:password@) from a Postgres URL before it lands in shared
// CI logs. TEST_DATABASE_URL can carry a real managed-Postgres password, so we
// never log the raw string. Falls back to a constant on an unparseable URL
// rather than risk echoing credentials.
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '<unparseable-url>';
  }
}

// Connectivity preflight for an externally provided TEST_DATABASE_URL (CI service
// container or explicit override). Unlike createDb (packages/beacon/src/storage/db.ts),
// which is fail-SOFT by contract (warns, returns a query-rejecting stub, never throws —
// REQUIREMENTS §1.3), a preflight must be fail-LOUD: an expected DB that cannot be
// reached should abort `bun test` early with a clear message, not let every integration
// suite trip its own beforeAll. Uses a one-shot connection with a bounded connect_timeout
// so a wedged host fails fast rather than hanging the run.
export async function verifyExternalDb(url: string): Promise<void> {
  // postgres.js throws SYNCHRONOUSLY at construction on a malformed/out-of-range URL,
  // but surfaces an unreachable host only on the awaited query — so construction and
  // the probe both live inside the try, and end() is guarded against an unbound sql.
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = postgres(url, { connect_timeout: 10, max: 1, onnotice: () => {} });
    await sql`select 1`;
  } catch (err) {
    throw new Error(
      `[test-db] TEST_DATABASE_URL is set but its Postgres is unreachable (${redactUrl(url)}): ${String(err)}`,
    );
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

async function ensureTestDb(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) {
    // Explicit override / CI service container wins — but verify it is reachable
    // and fail loud if not, rather than returning silently into skipped/broken suites.
    await verifyExternalDb(process.env.TEST_DATABASE_URL);
    return;
  }
  if (process.env.BEACON_TEST_DB === 'off') return; // pre-commit fast path

  // The compose host port defaults to 5544 (overridable via BEACON_PG_PORT),
  // matching docker-compose.yml; the credentials/db are fixed by that file.
  // `||` not `??`: an empty BEACON_PG_PORT must fall back to 5544, matching
  // docker-compose's `${BEACON_PG_PORT:-5544}` (which also treats '' as unset).
  const port = process.env.BEACON_PG_PORT || '5544';
  const url = `postgres://beacon:beacon@localhost:${port}/beacon`;

  try {
    // --wait-timeout bounds the wait: a wedged/never-healthy container fails
    // fast (warn + skip) instead of hanging `bun test` indefinitely. 60s clears
    // the healthcheck's ~30s worst case (2s interval x 15 retries) with headroom.
    const proc = Bun.spawn(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '60'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      console.warn(
        `[test-db] 'docker compose up -d --wait --wait-timeout 60' exited ${code}; integration suites will skip.` +
          (stderr ? `\n${stderr}` : ''),
      );
      return;
    }
  } catch (err) {
    // docker binary absent or not runnable — fall back to skip-gracefully.
    console.warn(
      `[test-db] could not start docker Postgres (${String(err)}); integration suites will skip.`,
    );
    return;
  }

  process.env.TEST_DATABASE_URL = url;
  console.log(`[test-db] Postgres ready — TEST_DATABASE_URL=${redactUrl(url)}`);
}

await ensureTestDb();
