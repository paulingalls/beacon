import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createIdentifyRelay, createIngestRelay } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the server's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

// story-004 CAPSTONE (Milestone 7): the trusted client-relay interface, end to end over a REAL
// Bun.serve socket. A product backend mounts the SDK relay handlers (createIngestRelay /
// createIdentifyRelay) and points a device's BeaconClient `endpoint` at them; the relay resolves
// the authenticated user, stamps user_id under the trusted bearer, and forwards to the deployed
// Beacon's POST {basePath}/events + /identify. Everything is read back through the QUERY API
// (GET {basePath}/events) — the agent/consumer read path. Unit coverage (stubbed fetch) lives in
// packages/beacon/src/relay/*.test.ts; this proves the relay → live ingest/identify → query seam
// composes over a real socket and DB: per-event user_id stamping, anonymous-stays-anonymous,
// device-asserted user_id stripping, and the login back-fill. A failure here means the relay
// round-trip regressed — exactly what it guards.

const PRODUCT = 'client-relay-roundtrip';
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';
const SECRET = 'client-relay-trusted-secret';

interface QueryEvent {
  event_type: string;
  visitor_token: string | null;
  user_id: string | null;
  product_id: string;
  properties: Record<string, unknown>;
}

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)(
  'capstone — trusted client relay (relay → ingest/identify → query)',
  () => {
    let sql: ReturnType<typeof createDb>;
    let beacon: ReturnType<typeof createBeacon>;
    let server: ReturnType<typeof Bun.serve>;
    let baseUrl: string;
    let ingestRelay: (request: Request) => Promise<Response>;
    let identifyRelay: (request: Request) => Promise<Response>;

    /** Simulate a device→backend request hitting a mounted relay handler. `userId` (when given)
     * is the authenticated user the backend's resolveUserId reads from the request. */
    function devicePost(
      handler: (request: Request) => Promise<Response>,
      body: unknown,
      userId?: string,
    ): Promise<Response> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (userId !== undefined) headers['x-user-id'] = userId;
      return handler(
        new Request('http://product-backend.example/relay', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
    }

    /** Read the events for one visitor token via the QUERY API (isAdmin:true serves reads). */
    async function eventsFor(token: string): Promise<QueryEvent[]> {
      const res = await fetch(`${baseUrl}${beacon.basePath}/events?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: QueryEvent[] };
      return body.events.filter((e) => e.visitor_token === token);
    }

    function byType(events: QueryEvent[], type: string): QueryEvent {
      const e = events.find((ev) => ev.event_type === type);
      if (!e) throw new Error(`no '${type}' event in the readback`);
      return e;
    }

    beforeAll(async () => {
      sql = createDb({ connectionString: TEST_DB as string });
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await runMigrations(sql);

      beacon = createBeacon({
        productId: PRODUCT,
        postgres: { connectionString: TEST_DB as string },
        isAdmin: () => true, // let the query API serve reads
        trustedIngestToken: SECRET, // the relays forward under this same bearer
        flushInterval: 60_000, // disable the server timer; the test drains via beacon.flush()
      });
      const app = new Hono();
      app.route(beacon.basePath, beacon.router()); // ingest + identify + query
      server = Bun.serve({ port: 0, fetch: app.fetch });
      baseUrl = `http://localhost:${server.port}`;

      // The product backend's relay handlers, pointing at the live deployed Beacon.
      ingestRelay = createIngestRelay({
        endpoint: `${baseUrl}${beacon.basePath}/events`,
        trustedIngestToken: SECRET,
        resolveUserId: (req) => req.headers.get('x-user-id'),
      });
      identifyRelay = createIdentifyRelay({
        endpoint: `${baseUrl}${beacon.basePath}/identify`,
        trustedIngestToken: SECRET,
        resolveUserId: (req) => req.headers.get('x-user-id'),
      });
    }, 15_000);

    afterAll(async () => {
      server.stop(true);
      await beacon.shutdown();
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await closeDb(sql);
    }, 15_000);

    test('E2E: an authenticated device batch is relayed with user_id stamped on every event', async () => {
      const res = await devicePost(
        ingestRelay,
        {
          product_id: PRODUCT,
          visitor_token: 'device-v1',
          events: [
            { event_type: 'screen_view', properties: { name: 'Home' } },
            { event_type: 'tap' },
          ],
        },
        'user-42',
      );
      expect(res.status).toBe(204);
      await beacon.flush();

      const events = await eventsFor('device-v1');
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.user_id === 'user-42')).toBe(true);
      expect(events.every((e) => e.product_id === PRODUCT)).toBe(true);
      expect(byType(events, 'screen_view').properties).toMatchObject({ name: 'Home' });
    }, 15_000);

    test('E2E: an unauthenticated device batch stays anonymous (no user_id)', async () => {
      const res = await devicePost(ingestRelay, {
        product_id: PRODUCT,
        visitor_token: 'device-anon',
        events: [{ event_type: 'page_open' }],
      }); // no x-user-id → resolveUserId returns null
      expect(res.status).toBe(204);
      await beacon.flush();

      const events = await eventsFor('device-anon');
      expect(events).toHaveLength(1);
      expect(byType(events, 'page_open').user_id).toBeNull();
      expect(byType(events, 'page_open').visitor_token).toBe('device-anon');
    }, 15_000);

    test('E2E: a device-asserted per-event user_id is stripped — only the resolved id is stored', async () => {
      const res = await devicePost(
        ingestRelay,
        {
          product_id: PRODUCT,
          visitor_token: 'device-forge',
          events: [{ event_type: 'tap', user_id: 'forged-admin' }],
        },
        'real-user',
      );
      expect(res.status).toBe(204);
      await beacon.flush();

      const events = await eventsFor('device-forge');
      expect(events).toHaveLength(1);
      expect(byType(events, 'tap').user_id).toBe('real-user'); // forged id never rode the bearer
    }, 15_000);

    test('E2E: the identify relay back-fills an anonymous trail to a user on login', async () => {
      // A self-contained anonymous trail.
      const seed = await devicePost(ingestRelay, {
        product_id: PRODUCT,
        visitor_token: 'device-login',
        events: [{ event_type: 'screen_view' }, { event_type: 'add_to_cart' }],
      });
      expect(seed.status).toBe(204);
      await beacon.flush();
      expect((await eventsFor('device-login')).every((e) => e.user_id === null)).toBe(true);

      // On login, the backend relays the association.
      const res = await devicePost(identifyRelay, { visitor_token: 'device-login' }, 'user-99');
      expect(res.status).toBe(204);
      await beacon.flush();

      const events = await eventsFor('device-login');
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.user_id === 'user-99')).toBe(true); // whole trail stitched
    }, 15_000);
  },
);
