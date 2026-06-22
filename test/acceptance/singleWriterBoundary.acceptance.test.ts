import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createHttpBeacon } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the deployed server's internals by relative path, as the sibling suites do.
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

// story-006 CAPSTONE (Milestone 4): the single-writer boundary is now PHYSICAL, not conventional.
// This proves the milestone's Definition of Done in one place — the negative (the published
// @pi-innovations/beacon-sdk has zero postgres in its dependency/module graph and exports only the
// locked emit-SDK + capture-core + wire-type surface) AND the positive (that postgres-free SDK still
// drives a full deployed round-trip into apps/server → Postgres → query). A failure here means the
// boundary regressed — the DB write path leaked back into a consumer's install graph.

const REPO_ROOT = join(import.meta.dir, '..', '..');

const SDK_PKG = '@pi-innovations/beacon-sdk'; // packages/beacon
const SERVER_PKG = '@pi-innovations/beacon-server'; // apps/server (the DB-cred holder)

registerDbCoverageGuard();

// --- bun.lock dependency-graph closure -------------------------------------------------------
// Resolve the transitive dependency closure of a workspace package from the lockfile. We use
// bun.lock — NOT a node_modules directory walk — because Bun hoists a `postgres` symlink into
// packages/beacon/node_modules from the root devDep, which would false-positive a directory scan.
//
// Lockfile shape (lockfileVersion 1):
//   workspaces[path] = { name, dependencies?, devDependencies? }
//   packages[name]   = [descriptor, registry, metadata, hash]  // metadata.dependencies/.optionalDependencies
// Workspace deps (workspace:*) have no metadata entry; their deps live back in workspaces[path].
interface BunLock {
  workspaces: Record<string, { name?: string; dependencies?: Record<string, string> }>;
  packages: Record<string, unknown[]>;
}

function readLock(): BunLock {
  // bun.lock is JSONC (trailing commas); strip them before JSON.parse. The pattern only matches a
  // comma followed by optional whitespace then a closing brace/bracket — lockfile hash strings are
  // alphanumeric (+/=), so it never touches string contents.
  const raw = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw) as BunLock;
}

/** Direct deps of a resolved package name: registry metadata first, else workspace declaration. */
function directDeps(lock: BunLock, name: string): string[] {
  const entry = lock.packages[name];
  const meta = Array.isArray(entry) && entry.length >= 3 ? entry[2] : undefined;
  const deps: Record<string, string> = {};
  if (meta && typeof meta === 'object') {
    const m = meta as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    Object.assign(deps, m.dependencies, m.optionalDependencies);
  }
  // Workspace package (workspace:*): its deps are declared in the workspaces table.
  const wsPath = Object.keys(lock.workspaces).find((p) => lock.workspaces[p].name === name);
  if (wsPath) Object.assign(deps, lock.workspaces[wsPath].dependencies);
  return Object.keys(deps);
}

/** Transitive dependency closure of a workspace package (by its declared package name). */
function depClosure(lock: BunLock, pkgName: string): Set<string> {
  const wsPath = Object.keys(lock.workspaces).find((p) => lock.workspaces[p].name === pkgName);
  if (!wsPath) throw new Error(`workspace package not found in bun.lock: ${pkgName}`);
  const seen = new Set<string>();
  const stack = Object.keys(lock.workspaces[wsPath].dependencies ?? {});
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of directDeps(lock, name)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/** Recursively collect .ts files under a directory. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('single-writer boundary — published SDK graph is postgres-free', () => {
  test('the SDK dependency closure contains no postgres (bun.lock)', () => {
    const closure = depClosure(readLock(), SDK_PKG);
    expect(closure.has('postgres')).toBe(false);
    expect(closure.has('hono')).toBe(true); // sanity: closure resolved something real
  });

  test('TEETH: the same closure walk DOES find postgres in the deployed server graph', () => {
    // Positive control — proves the closure assertion above is not vacuously green: the walk
    // detects postgres when it IS a dependency (apps/server is the sole DB-cred holder).
    const closure = depClosure(readLock(), SERVER_PKG);
    expect(closure.has('postgres')).toBe(true);
  });

  test('packages/beacon/package.json declares no postgres dependency', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/beacon/package.json'), 'utf8'),
    ) as { name: string; dependencies?: Record<string, string> };
    expect(pkg.name).toBe(SDK_PKG);
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('postgres');
  });

  test('no SDK source file imports postgres', () => {
    const importRe = /from\s+['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)/;
    const offenders = tsFiles(join(REPO_ROOT, 'packages/beacon/src')).filter((f) =>
      importRe.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  test('the SDK runtime export surface is exactly the locked set (no server symbols)', async () => {
    // Decision beacon-sdk-public-surface: emit SDK + capture cores + wire types only. Types are
    // erased at runtime, so this asserts the VALUE exports; exact-set equality also catches drift
    // (any accidental new export fails here).
    const sdk = (await import('@pi-innovations/beacon-sdk')) as Record<string, unknown>;
    const exported = Object.keys(sdk).sort();
    expect(exported).toEqual(
      [
        'MAX_EVENT_TYPE_LENGTH',
        'buildEventContext',
        'createHttpBeacon',
        'defaultClientAddress',
        'extractAttribution',
        'firstLocale',
        'hashIp',
        'honoRequest',
        'honoToBeaconRequest',
        'parseAppContext',
        'requestToBeaconRequest',
        'resolveEventFields',
        'resolveEventFieldsFromRequest',
        'resolveIp',
        'resolveIpFromRequest',
        'track',
      ].sort(),
    );
    // The DB write path must be unreachable from the SDK entry.
    for (const forbidden of ['createBeacon', 'createDb', 'closeDb', 'runMigrations']) {
      expect(exported).not.toContain(forbidden);
    }
    // No query/dashboard/handler builders leaked onto the surface.
    expect(exported.filter((k) => /dashboard|query|Handler/i.test(k))).toEqual([]);
  });
});

// --- Deployed round-trip via the postgres-free SDK (AC2 http_websocket + AC3 sdk) -------------
const PRODUCT = 'single-writer-capstone';
const SECRET = 'capstone-boundary-secret';
const TOKEN = 'v-boundary';
const TOKEN2 = 'v-other'; // a second anonymous visitor in the same drained batch
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';

interface QueriedEvent {
  event_type: string;
  user_id: string | null;
  visitor_token: string | null;
  properties: { path?: string; sku?: string };
}

describe.skipIf(!TEST_DB)(
  'single-writer boundary — postgres-free SDK still drives the deployed round-trip',
  () => {
    let sql: ReturnType<typeof createDb>;
    let beacon: ReturnType<typeof createBeacon>;
    let httpBeacon: ReturnType<typeof createHttpBeacon>;
    let server: ReturnType<typeof Bun.serve>;
    let baseUrl: string;

    function query(path: string): Promise<Response> {
      return fetch(`${baseUrl}${beacon.basePath}${path}`);
    }

    beforeAll(async () => {
      sql = createDb({ connectionString: TEST_DB as string });
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await runMigrations(sql);

      // The DEPLOYED Beacon — the only DB-cred holder (apps/server). Trusted ingest enabled so the
      // SDK relay's per-event user_id is honored; isAdmin opens the query API for read-back.
      beacon = createBeacon({
        productId: PRODUCT,
        postgres: { connectionString: TEST_DB as string },
        isAdmin: () => true,
        trustedIngestToken: SECRET,
        flushInterval: 60_000,
      });
      const app = new Hono();
      app.route(beacon.basePath, beacon.router());
      server = Bun.serve({ port: 0, fetch: app.fetch });
      baseUrl = `http://localhost:${server.port}`;

      // The PRODUCT — a Bun.serve emitter built on the PUBLISHED postgres-free SDK, emitting over the
      // real network using the default fetch (the HTTP boundary under test).
      httpBeacon = createHttpBeacon({
        productId: PRODUCT,
        endpoint: `${baseUrl}${beacon.basePath}/events`,
        trustedIngestToken: SECRET,
        getUserId: (req) => req.headers.get('x-user'),
        flushInterval: 60_000,
      });
    }, 15_000);

    afterAll(async () => {
      await httpBeacon.shutdown();
      server.stop(true);
      await beacon.shutdown();
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await closeDb(sql);
    }, 15_000);

    test('E2E: SDK capture + track persist via trusted ingest and read back through the query API', async () => {
      httpBeacon.capture(new Request(`${baseUrl}/landing?_t=${TOKEN}`), {
        clientAddress: '192.0.2.5',
        status: 200,
        responseTimeMs: 12,
      });
      httpBeacon.track(
        new Request(`${baseUrl}/buy?_t=${TOKEN}`, { headers: { 'x-user': 'alice' } }),
        'purchase',
        { sku: 'sku-9' },
      );
      // A SECOND anonymous visitor in the SAME drained batch — proves per-event visitor_token
      // end to end: HttpSink sends one trusted POST, ingest attributes each event to its own token.
      httpBeacon.track(new Request(`${baseUrl}/welcome?_t=${TOKEN2}`), 'signup', {});

      await httpBeacon.flush();
      await beacon.flush();

      const res = await query(`/events?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: QueriedEvent[] };
      expect(body.events.length).toBe(3);
      const byType = new Map(body.events.map((e) => [e.event_type, e]));

      const request = byType.get('request');
      expect(request?.properties.path).toBe('/landing');
      expect(request?.visitor_token).toBe(TOKEN);
      expect(request?.user_id).toBeNull();

      const purchase = byType.get('purchase');
      expect(purchase?.user_id).toBe('alice');
      expect(purchase?.visitor_token).toBe(TOKEN);
      expect(purchase?.properties.sku).toBe('sku-9');

      // The second visitor's event landed with ITS token, not TOKEN — distinct per-event
      // attribution survived the single-batch trusted round-trip.
      const signup = byType.get('signup');
      expect(signup?.visitor_token).toBe(TOKEN2);
      expect(signup?.user_id).toBeNull();
    }, 15_000);
  },
);
