import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createHttpBeacon } from '@pi-innovations/beacon';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the package's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../packages/beacon/src/storage/db';
import { runMigrations } from '../../packages/beacon/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../packages/beacon/test/dbGuard';

// story-004 CAPSTONE (Milestone 3): the framework-agnostic HTTP single-writer path exercised end to
// end over a REAL HTTP boundary. A Bun.serve product uses createHttpBeacon (no Hono, no Postgres, no
// DB creds) to capture() a request and track() a custom event; HttpSink POSTs them — Authorization:
// Bearer — to a SEPARATELY deployed createBeacon over the network, where they persist and are read
// back through the QUERY API. stories 001-003 proved each layer in isolation with a fake fetch; this
// proves the product → trusted ingest → query round-trip across the http_websocket surface. A failure
// here means the M3 emit contract regressed across a seam no single unit test covers.

const PRODUCT = 'bun-serve-http-writer';
const SECRET = 'capstone-bunserve-secret';
const TOKEN = 'v-capstone';
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';

registerDbCoverageGuard();

interface QueriedEvent {
  event_type: string;
  user_id: string | null;
  visitor_token: string | null;
  properties: { path?: string; method?: string; status?: number; sku?: string };
}

describe.skipIf(!TEST_DB)(
  'capstone — Bun.serve product → trusted ingest → query (HTTP single-writer)',
  () => {
    let sql: ReturnType<typeof createDb>;
    let beacon: ReturnType<typeof createBeacon>;
    let httpBeacon: ReturnType<typeof createHttpBeacon>;
    let server: ReturnType<typeof Bun.serve>;
    let baseUrl: string;

    /** GET a query endpoint over the network (the admin/agent consumer path). */
    function query(path: string): Promise<Response> {
      return fetch(`${baseUrl}${beacon.basePath}${path}`);
    }

    beforeAll(async () => {
      sql = createDb({ connectionString: TEST_DB as string });
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await runMigrations(sql);

      // The DEPLOYED Beacon — the only DB-cred holder. trustedIngestToken enables the M2 path so the
      // relay's per-event user_id is honored; isAdmin lets the query API serve reads. No getUserId: a
      // relay connection has no host session, so identity rides per-event in the trusted body.
      beacon = createBeacon({
        productId: PRODUCT,
        postgres: { connectionString: TEST_DB as string },
        isAdmin: () => true,
        trustedIngestToken: SECRET,
        flushInterval: 60_000, // disable the server timer; the test drains via beacon.flush()
      });
      const app = new Hono();
      app.route(beacon.basePath, beacon.router()); // mounts BOTH the ingest and the query endpoints
      server = Bun.serve({ port: 0, fetch: app.fetch });
      baseUrl = `http://localhost:${server.port}`;

      // The PRODUCT — a Bun.serve app with no DB. Emits over the real network to the deployed ingest
      // using the DEFAULT fetch (no injection): this is the actual HTTP boundary under test.
      httpBeacon = createHttpBeacon({
        productId: PRODUCT,
        endpoint: `${baseUrl}${beacon.basePath}/events`,
        trustedIngestToken: SECRET,
        getUserId: (req) => req.headers.get('x-user'),
        flushInterval: 60_000, // drain via httpBeacon.flush()
      });
    }, 15_000);

    afterAll(async () => {
      await httpBeacon.shutdown();
      server.stop(true);
      await beacon.shutdown();
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await closeDb(sql);
    }, 15_000);

    test('E2E: capture + track emit over the trusted HTTP boundary, persist, and read back via the query API', async () => {
      // Anonymous request event — visitor handle carried via the _t query param.
      httpBeacon.capture(new Request(`${baseUrl}/product/page?_t=${TOKEN}`), {
        clientAddress: '192.0.2.1',
        status: 200,
        responseTimeMs: 45,
      });
      // Authenticated custom event — getUserId resolves 'alice', honored per-event under the bearer.
      httpBeacon.track(
        new Request(`${baseUrl}/buy?_t=${TOKEN}`, { headers: { 'x-user': 'alice' } }),
        'purchase',
        { sku: 'a1' },
      );

      // Product flushes over the wire (both events share _t → one grouped POST with Bearer), then the
      // deployed Beacon drains its buffer to Postgres.
      await httpBeacon.flush();
      await beacon.flush();

      // Read back through the query API.
      const res = await query(`/events?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: QueriedEvent[] };
      // Exactly the two emitted events round-tripped — guards against silent extra/missing events
      // (a vacuous pass: per-type asserts on a Map would still hold if a third event slipped in).
      expect(body.events.length).toBe(2);
      const byType = new Map(body.events.map((e) => [e.event_type, e]));

      // The captured request event: path/method/status carried, anonymous visitor handle preserved.
      const request = byType.get('request');
      expect(request?.properties.path).toBe('/product/page');
      expect(request?.properties.method).toBe('GET');
      expect(request?.properties.status).toBe(200);
      expect(request?.visitor_token).toBe(TOKEN);
      expect(request?.user_id).toBeNull();

      // The tracked custom event: per-event user_id honored under trust; same visitor handle; props intact.
      const purchase = byType.get('purchase');
      expect(purchase?.user_id).toBe('alice');
      expect(purchase?.visitor_token).toBe(TOKEN);
      expect(purchase?.properties.sku).toBe('a1');

      // A second query surface over the wire: the aggregate count endpoint sees both product events.
      const agg = await query(`/aggregate?${WINDOW}&product_id=${PRODUCT}&metric=count`);
      expect(agg.status).toBe(200);
      const aggBody = (await agg.json()) as { metric: string; value: number };
      expect(aggBody.value).toBe(2);
    }, 15_000);
  },
);
