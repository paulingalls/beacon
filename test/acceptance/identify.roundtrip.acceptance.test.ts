import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the server's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

// story-002 CAPSTONE (Milestone 5): the trusted HTTP identify back-fill, end to end over a REAL
// Bun.serve socket. The server middleware mints an anonymous trail (+ captures first-touch
// attribution), the host relays a login to POST {basePath}/identify with the trusted bearer, and
// the back-fill is read back through the QUERY API (GET {basePath}/events) — the agent/consumer
// read path. Unit/integration coverage lives in apps/server/src/api/identify.test.ts +
// visitors/associate.test.ts; this proves the middleware → identify → query seam composes, and
// that the trust gate survives the real socket path (not just in-process app.request). A failure
// here means the identify round-trip regressed — exactly what it guards.

const PRODUCT = 'identify-roundtrip';
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';
const TRUSTED = 'trusted-secret';

interface QueryEvent {
  event_type: string;
  visitor_token: string | null;
  user_id: string | null;
  timestamp: string;
  attribution: { utm_source?: string };
}

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)(
  'capstone — HTTP identify back-fill (middleware → identify → query)',
  () => {
    let sql: ReturnType<typeof createDb>;
    let beacon: ReturnType<typeof createBeacon>;
    let server: ReturnType<typeof Bun.serve>;
    let baseUrl: string;

    /** Mint an anonymous trail over the network: an attributed first hit, then a second hit on the
     * same token (distinct timestamp), and the persisted flush. Returns the minted token. */
    async function mintTrail(): Promise<string> {
      const first = await fetch(`${baseUrl}/p?utm_source=newsletter`);
      const token = await first.text();
      // Separate the two hits by a wide enough margin that their millisecond-precision
      // event timestamps cannot collide — the DB back-fills attribution onto the
      // earliest (timestamp ASC, received_at ASC) event, but the query API returns no
      // received_at tiebreaker, so distinct timestamps are what make the earliest-event
      // assert deterministic.
      await Bun.sleep(50);
      await fetch(`${baseUrl}/p?_t=${token}`);
      await beacon.flush();
      return token;
    }

    /** Read the events for one visitor token via the QUERY API, oldest-first. */
    async function trailFor(token: string): Promise<QueryEvent[]> {
      const res = await fetch(`${baseUrl}${beacon.basePath}/events?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: QueryEvent[] };
      return body.events
        .filter((e) => e.visitor_token === token)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    beforeAll(async () => {
      sql = createDb({ connectionString: TEST_DB as string });
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await runMigrations(sql);

      beacon = createBeacon({
        productId: PRODUCT,
        postgres: { connectionString: TEST_DB as string },
        isAdmin: () => true, // let the query API serve reads
        trustedIngestToken: TRUSTED, // enable the trusted identify endpoint
        flushInterval: 60_000, // disable the server timer; the test drains via beacon.flush()
      });
      const app = new Hono();
      app.use('*', beacon.middleware()); // mints tokens + captures attribution + logs page events
      app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));
      app.route(beacon.basePath, beacon.router()); // ingest + identify + query
      server = Bun.serve({ port: 0, fetch: app.fetch });
      baseUrl = `http://localhost:${server.port}`;
    }, 15_000);

    afterAll(async () => {
      server.stop(true);
      await beacon.shutdown();
      await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
      await closeDb(sql);
    }, 15_000);

    test('E2E: a trusted login relay back-fills the minted trail, read back via the query API', async () => {
      const token = await mintTrail();

      const res = await fetch(`${baseUrl}${beacon.basePath}/identify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TRUSTED}`, 'content-type': 'application/json' },
        body: JSON.stringify({ visitor_token: token, user_id: 'user-42' }),
      });
      expect(res.status).toBe(204);
      await beacon.flush(); // drain the middleware-logged identify request too

      const trail = await trailFor(token);
      expect(trail).toHaveLength(2); // the two page hits on this token (identify's own log uses a fresh token)
      expect(trail.every((e) => e.user_id === 'user-42')).toBe(true); // whole trail back-filled
      // First-touch lands on exactly ONE event, and it is the earliest (oldest-first sort).
      const attributed = trail.filter((e) => e.attribution.utm_source === 'newsletter');
      expect(attributed).toHaveLength(1);
      expect(trail[0]?.attribution.utm_source).toBe('newsletter'); // first-touch on the earliest event
      expect(trail[1]?.attribution.utm_source).toBeUndefined(); // only the earliest
    }, 15_000);

    test('E2E: an untrusted identify is rejected (403) over the real socket and back-fills nothing', async () => {
      const token = await mintTrail();

      const res = await fetch(`${baseUrl}${beacon.basePath}/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, // no bearer
        body: JSON.stringify({ visitor_token: token, user_id: 'user-99' }),
      });
      expect(res.status).toBe(403);
      await beacon.flush();

      const trail = await trailFor(token);
      expect(trail).toHaveLength(2); // both minted hits persist — a rejected identify drops nothing
      expect(trail.every((e) => e.user_id === null)).toBe(true); // untrusted caller never back-fills
    }, 15_000);
  },
);
