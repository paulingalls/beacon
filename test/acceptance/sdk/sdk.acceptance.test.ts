import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createBeacon } from '@pi-innovations/beacon';
// The assembled SDK, imported BY PACKAGE NAME so this exercises the exports map + the whole
// client end-to-end (story-005's exports → core client → real HTTP → live ingest → Postgres).
import { BeaconClient } from '@pi-innovations/beacon-client';
import { Hono } from 'hono';
// Live-DB setup via the package's own internals by relative path, exactly as the sibling
// acceptance suites do (test/acceptance/http.acceptance.test.ts).
import { closeDb, createDb } from '../../../packages/beacon/src/storage/db';
import { runMigrations } from '../../../packages/beacon/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../../packages/beacon/test/dbGuard';

const PRODUCT = 'sdk-acceptance';

registerDbCoverageGuard();

/** Poll until `check` is truthy or the timeout elapses — for the auto-flush network round-trip. */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

// SDK acceptance capstone: a REAL @pi-innovations/beacon-client driving a REAL Beacon ingest
// server (Bun.serve + createBeacon on Postgres) over the network, asserting events persist to
// beacon_events. The genuine cross-package integration the unit suites can't cover.
describe.skipIf(!TEST_DB)('SDK acceptance — beacon-client → live ingest → Postgres', () => {
  let sql: ReturnType<typeof createDb>;
  let beacon: ReturnType<typeof createBeacon>;
  let server: ReturnType<typeof Bun.serve>;
  let endpoint: string;

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);

    beacon = createBeacon({
      productId: PRODUCT,
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      getUserId: () => null,
      flushInterval: 60_000, // disable the server timer; tests drain via beacon.flush()
    });
    const app = new Hono();
    app.route(beacon.basePath, beacon.router()); // mounts POST {basePath}/events ingest
    server = Bun.serve({ port: 0, fetch: app.fetch });
    endpoint = `http://localhost:${server.port}${beacon.basePath}/events`;
  }, 15_000);

  beforeEach(async () => {
    await sql`TRUNCATE beacon_events`;
  });

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  }, 15_000);

  test('a consumer tracks + flushes and the events persist via the live ingest', async () => {
    const client = new BeaconClient({
      endpoint,
      productId: PRODUCT,
      appContext: { appVersion: '1.0.0', platform: 'web' },
      flushInterval: 60_000,
    });
    try {
      client.track('button_tap', { button: 'create_clip' });
      client.screenView('HomeScreen');
      await client.flush(); // SDK POSTs the batch to the live ingest (202)
      await beacon.flush(); // drain the server buffer to Postgres

      const rows = (await sql`
        SELECT event_type, properties, platform, context
        FROM beacon_events WHERE product_id = ${PRODUCT} ORDER BY event_type
      `) as Array<{
        event_type: string;
        properties: Record<string, unknown>;
        platform: string;
        context: { app_context?: Record<string, unknown> };
      }>;

      expect(rows.map((r) => r.event_type)).toEqual(['button_tap', 'screen_view']);
      const tap = rows.find((r) => r.event_type === 'button_tap');
      expect(tap?.properties).toEqual({ button: 'create_clip' });
      const screen = rows.find((r) => r.event_type === 'screen_view');
      expect(screen?.properties).toEqual({ screen: 'HomeScreen' });
      // The X-App-Context the SDK attached round-trips into the event context + platform.
      expect(tap?.platform).toBe('web');
      expect(tap?.context.app_context).toMatchObject({ appVersion: '1.0.0', platform: 'web' });
    } finally {
      client.shutdown();
    }
  });

  test('E2E: a client with a DIFFERENT productId than the server keeps its own product_id in Postgres', async () => {
    // The mislabeling regression guard (concern 168d25841201): on a shared ingest,
    // SDK events must land under the CLIENT's product, not the host instance's.
    const client = new BeaconClient({
      endpoint,
      productId: `${PRODUCT}-other`,
      appContext: { appVersion: '1.0.0', platform: 'web' },
      flushInterval: 60_000,
    });
    try {
      client.track('cross_product_tap');
      await client.flush();
      await beacon.flush();

      const rows = (await sql`
        SELECT product_id FROM beacon_events WHERE event_type = 'cross_product_tap'
      `) as Array<{ product_id: string }>;
      expect(rows.map((r) => r.product_id)).toEqual([`${PRODUCT}-other`]);
      // Independent fallback guard, queried separately so it still protects even if the
      // assertion above is later relaxed: the table is truncated per-test, so ANY row under
      // the server's product here means ingest relabeled or duplicated this client's event.
      const serverProductRows = await sql`
        SELECT event_type FROM beacon_events WHERE product_id = ${PRODUCT}
      `;
      expect(serverProductRows).toHaveLength(0);
    } finally {
      client.shutdown();
    }
  });

  test('reaching maxBatchSize auto-flushes from the SDK to the live ingest', async () => {
    const before = beacon.stats().buffered + beacon.stats().flushed;
    const client = new BeaconClient({
      endpoint,
      productId: PRODUCT,
      appContext: { appVersion: '1.0.0', platform: 'web' },
      maxBatchSize: 3,
      flushInterval: 60_000, // only the size trigger can fire a flush here
    });
    try {
      for (let n = 0; n < 3; n++) client.track('tap', { n });
      // No manual client.flush(): the size trigger must POST on its own. Wait for the server
      // to receive the batch (buffered/flushed advances), proving the auto-flush reached ingest.
      await waitFor(() => beacon.stats().buffered + beacon.stats().flushed >= before + 3);
      await beacon.flush();

      const rows =
        await sql`SELECT properties FROM beacon_events WHERE product_id = ${PRODUCT} AND event_type = 'tap'`;
      expect(rows).toHaveLength(3);
    } finally {
      client.shutdown();
    }
  });
});
