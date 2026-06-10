import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBeacon } from '@pi-innovations/beacon';
import { Hono } from 'hono';
// Reach the package's DB internals by relative path for live-DB setup, exactly
// as http.acceptance.test.ts and the package's own integration suites do.
import { closeDb, createDb } from '../../packages/beacon/src/storage/db';
import { runMigrations } from '../../packages/beacon/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../packages/beacon/test/dbGuard';

// Over-network capstone for Milestone 2 (URL shortener). Boots a REAL server
// (Bun.serve + fetch) with beacon.shortener() mounted against a live migrated
// Postgres and proves the full surface composes: an admin creates a link, a
// visitor follows it to a 302, and a short_link_click event lands in
// beacon_events after a flush — the seam an AI agent or the dashboard's traffic
// path exercises. Mirrors test/acceptance/http.acceptance.test.ts. Gated on
// TEST_DATABASE_URL, which the bun-test preload auto-starts (test/setup/ensure-test-db.ts).

const SHORT_DOMAIN = 'https://pi.ink';

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('shortener acceptance — real HTTP traffic', () => {
  let sql: ReturnType<typeof createDb>;
  let beacon: ReturnType<typeof createBeacon>;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);

    beacon = createBeacon({
      productId: 'acceptance',
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      shortDomain: SHORT_DOMAIN,
      flushInterval: 60_000, // we flush() manually; no timer races
    });
    const app = new Hono();
    app.use('*', beacon.middleware()); // realistic: mints the visitor token carried on the click
    app.route('/', beacon.shortener()); // POST /short + GET /:code at the root
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  }, 15_000);

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  }, 15_000);

  /** POST /short over the wire. Extra headers (e.g. none) merge over the JSON content-type. */
  function postShort(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/short`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  /** GET /:code without following the redirect — captures the 302 + Location and
   * never dials out to the destination host. */
  function getCode(code: string): Promise<Response> {
    return fetch(`${baseUrl}/${code}`, { redirect: 'manual' });
  }

  /** The short_link_click row for one code (scoped by code so tests don't collide). */
  function clickRow(code: string): Promise<{ product_id: string; code: string; dest: string }[]> {
    return sql<{ product_id: string; code: string; dest: string }[]>`
      SELECT product_id, properties->>'code' AS code, properties->>'destination' AS dest
      FROM beacon_events
      WHERE event_type = 'short_link_click' AND properties->>'code' = ${code}`;
  }

  test('admin POST /short → 201, visitor GET /:code → 302, and a short_link_click lands after flush', async () => {
    const created = await postShort({
      destination: 'https://example.com/landing',
      product_id: 'promo',
    });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { code: string; url: string };
    expect(link.code).toBeTruthy();
    expect(link.url).toBe(`${SHORT_DOMAIN}/${link.code}`);

    const redirect = await getCode(link.code);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.com/landing');

    await beacon.flush();
    const rows = await clickRow(link.code);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product_id).toBe('promo'); // product_id from the LINK, not the Beacon
    expect(rows[0]?.dest).toBe('https://example.com/landing');
  }, 15_000);

  test('createShortLink() (programmatic, no HTTP) yields a code that redirects + logs a click over the wire', async () => {
    const link = await beacon.createShortLink({
      destination: 'https://example.com/api-made',
      productId: 'promo',
    });
    expect(link.url).toBe(`${SHORT_DOMAIN}/${link.code}`);

    const redirect = await getCode(link.code);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.com/api-made');

    await beacon.flush();
    const rows = await clickRow(link.code);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dest).toBe('https://example.com/api-made');
  }, 15_000);

  test('an unknown code returns a 404 page (no redirect, no event)', async () => {
    // A hyphenated code is structurally impossible for the base62 generateCode to
    // mint and is created by no test, so this 404 can never alias a real link —
    // even across the suite's shared DB.
    const res = await getCode('no-such-code');
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  }, 15_000);

  test('a non-admin POST /short is denied with a §5.5 UNAUTHORIZED 403 over the network', async () => {
    // The admin gate runs over a real socket, not just in-process. A separate
    // beacon/server so the deny path is isolated (fresh limiter + no shared state).
    const denyBeacon = createBeacon({
      productId: 'acceptance',
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => false,
      shortDomain: SHORT_DOMAIN,
      flushInterval: 60_000,
    });
    const app = new Hono();
    app.route('/', denyBeacon.shortener());
    const denyServer = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const res = await fetch(`http://localhost:${denyServer.port}/short`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: 'https://example.com/x', product_id: 'promo' }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    } finally {
      denyServer.stop(true);
      await denyBeacon.shutdown();
    }
  }, 15_000);
});
