import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// The assembled SDK imported BY PACKAGE NAME — exercises the exports map + the whole client,
// exactly as test/acceptance/sdk/sdk.acceptance.test.ts does.
import { BeaconClient } from '@pi-innovations/beacon-client';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the package's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

// story-003 CAPSTONE (Milestone 1): the cross-package wire contract — the body-level
// `visitor_token` field name and body-wins precedence — is exercised end to end by a REAL
// beacon-client driving a REAL ingest, then read back through the QUERY API (GET {basePath}/events),
// the agent/dashboard-facing read path. story-001 proved server-only (raw POST); story-002 proved
// client→DB via raw SQL; this proves the full client → ingest → query consumer round-trip across
// both covered surfaces. A failure here means the wire contract regressed — exactly what it guards.

const PRODUCT = 'visitor-roundtrip';
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('capstone — visitor_token round-trip (client → ingest → query)', () => {
  let sql: ReturnType<typeof createDb>;
  let beacon: ReturnType<typeof createBeacon>;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  /** GET a query endpoint over the network through the admin server. */
  function query(path: string): Promise<Response> {
    return fetch(`${baseUrl}${beacon.basePath}${path}`);
  }

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);

    // No getUserId: the cookie-free SPA visitor is anonymous. isAdmin lets the query API serve reads.
    beacon = createBeacon({
      productId: PRODUCT,
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      flushInterval: 60_000, // disable the server timer; the test drains via beacon.flush()
    });
    const app = new Hono();
    app.route(beacon.basePath, beacon.router()); // mounts BOTH the ingest and the query endpoints
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  }, 15_000);

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  }, 15_000);

  test('E2E: a real BeaconClient handle (seed + rotate) survives ingest and reads back via the query API', async () => {
    const client = new BeaconClient({
      endpoint: `${baseUrl}${beacon.basePath}/events`,
      productId: PRODUCT,
      appContext: { appVersion: '1.0.0', platform: 'web' },
      flushInterval: 60_000,
      visitorToken: 'visitor-1',
    });
    try {
      // Seed the production way: the SDK POSTs body.visitor_token over the wire; drain to Postgres.
      client.track('page_view', { path: '/home' });
      await client.flush();
      await beacon.flush();

      // Rotate the anonymous handle mid-session — subsequent events attribute to the new one.
      client.setVisitorToken('visitor-2');
      client.track('page_view', { path: '/pricing' });
      await client.flush();
      await beacon.flush();

      // Read back through the QUERY API (not raw SQL) — the consumer/agent path.
      const res = await query(`/events?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: Array<{
          event_type: string;
          visitor_token: string | null;
          user_id: string | null;
          properties: { path?: string };
        }>;
      };

      expect(body.events).toHaveLength(2);
      // Order-tolerant: the query returns newest-first, so sort by the page path for a stable assert.
      const byPath = [...body.events].sort((a, b) =>
        (a.properties.path ?? '').localeCompare(b.properties.path ?? ''),
      );
      expect(byPath.map((e) => e.properties.path)).toEqual(['/home', '/pricing']);
      expect(byPath.map((e) => e.visitor_token)).toEqual(['visitor-1', 'visitor-2']);
      // Anonymous throughout — no getUserId on the server, no body user_id from the public client.
      expect(byPath.every((e) => e.user_id === null)).toBe(true);
    } finally {
      client.shutdown();
    }
  }, 15_000);
});
