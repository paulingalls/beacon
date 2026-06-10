import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBeacon } from '@pi-innovations/beacon';
import { Hono } from 'hono';
// Reach the package's DB internals by relative path for live-DB setup, exactly
// as the package's own integration suites do (packages/beacon/test/helpers.ts).
import { closeDb, createDb } from '../../packages/beacon/src/storage/db';
import { runMigrations } from '../../packages/beacon/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../packages/beacon/test/dbGuard';

// HTTP acceptance harness for the Beacon server surface. Unlike the in-process
// app.request() unit/e2e tests, this drives a REAL server over the network
// (Bun.serve + fetch) — the higher-fidelity seam that future cross-package
// end-to-end tests (e.g. the beacon-client SDK posting to the ingest endpoint)
// will plug into. Postgres is intentionally unreachable so this smoke needs no
// external services: §1.3 failure isolation keeps the request unaffected by the
// DB outage. As Milestones 4-5 land the ingest + query API, add real acceptance
// scenarios here against a live test database.

describe('http acceptance — Beacon serves real HTTP traffic', () => {
  let server: ReturnType<typeof Bun.serve>;
  let beacon: ReturnType<typeof createBeacon>;
  let baseUrl: string;

  beforeAll(() => {
    beacon = createBeacon({
      productId: 'acceptance',
      postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/health', (c) => c.json({ ok: true }));

    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
  }, 15_000);

  test('GET /health returns 200 over the network AND the middleware logged the request', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Prove the Beacon middleware actually ran (not a silent no-op): it buffers
    // the request event before the response returns, so the count is now > 0.
    expect(beacon.stats().buffered).toBeGreaterThan(0);
  });
});

/**
 * Stand up a fresh Beacon + real server, run fn(baseUrl), then tear down. A fresh
 * beacon per call means a fresh RateLimiter window, so the 429 test is deterministic.
 * Postgres stays unreachable — the ingest endpoint buffers fire-and-forget and returns
 * 202 regardless of the DB, so this surface needs no external services.
 */
async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const beacon = createBeacon({
    productId: 'acceptance',
    postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    flushInterval: 60_000,
  });
  const app = new Hono();
  app.use('*', beacon.middleware());
  app.route(beacon.basePath, beacon.router());
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    await fn(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
    await beacon.shutdown();
  }
}

function postEvents(baseUrl: string, events: unknown[]): Promise<Response> {
  return fetch(`${baseUrl}/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

describe('http acceptance — POST /analytics/events ingest over the network', () => {
  test('accepts an event batch and returns 202 { accepted } over the wire', async () => {
    await withServer(async (baseUrl) => {
      const res = await postEvents(baseUrl, [
        { event_type: 'screen_view' },
        { event_type: 'button_tap' },
      ]);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: 2, product_id_used: 'acceptance' });
    });
  }, 15_000);

  test('rate-limits a caller past the per-minute limit with a 429 + Retry-After', async () => {
    await withServer(async (baseUrl) => {
      // Default limit is 10/min per caller. Unauthenticated, so the identifier is the
      // resolved client IP — stable across these localhost fetches (and if getConnInfo
      // yields nothing, ingest's 'unknown' sentinel keys them together just the same),
      // so request 11 deterministically trips the window.
      for (let i = 0; i < 10; i++) {
        const ok = await postEvents(baseUrl, [{ event_type: 'e' }]);
        expect(ok.status).toBe(202);
      }
      const denied = await postEvents(baseUrl, [{ event_type: 'e' }]);
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    });
  }, 15_000);
});

// Capstone (story-008): the five query endpoints end-to-end over a real socket
// against a live Postgres. Seeds through the production ingest path (POST +
// flush, which upserts beacon_events AND beacon_meta), then drives every read
// endpoint over fetch — the seam an AI agent or the dashboard uses. Gated on
// TEST_DATABASE_URL so the DB-free smokes above still run with no services.
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('http acceptance — query API over the network', () => {
  let sql: ReturnType<typeof createDb>;
  let beacon: ReturnType<typeof createBeacon>;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  // admin-1 views, then signs up an hour later → the funnel converts.
  const SEED = [
    { event_type: 'view', timestamp: '2026-03-01T00:00:00Z' },
    { event_type: 'signup', timestamp: '2026-03-01T01:00:00Z' },
  ];

  /** GET a query endpoint over the network through the admin server. */
  function query(path: string): Promise<Response> {
    return fetch(`${baseUrl}/analytics${path}`);
  }

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);

    beacon = createBeacon({
      productId: 'acceptance',
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      getUserId: () => 'admin-1',
      flushInterval: 60_000,
    });
    // No request-logging middleware here: this exercises the query API, and the
    // middleware would log each POST/GET as its own 'request' event, inflating
    // the seeded count. Ingest + queries are router routes, independent of it.
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;

    // Seed the production way: ingest over the wire, then drain to Postgres.
    const ingest = await postEvents(baseUrl, SEED);
    expect(ingest.status).toBe(202);
    await beacon.flush();
  }, 15_000);

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  }, 15_000);

  test('GET /schema returns the seeded product, event types, and the advertised endpoints', async () => {
    const res = await query('/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      products: string[];
      event_types: unknown[];
      endpoints: Record<string, unknown>;
    };
    expect(body.products).toContain('acceptance');
    expect(body.event_types.length).toBeGreaterThan(0);
    expect(Object.keys(body.endpoints).sort()).toEqual([
      'aggregate',
      'attribution',
      'events',
      'funnel',
    ]);
  });

  test('GET /events returns the seeded events newest-first with a has_more flag', async () => {
    const res = await query(`/events?${WINDOW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { event_type: string }[];
      has_more: boolean;
    };
    expect(body.events).toHaveLength(SEED.length);
    expect(body.events[0]?.event_type).toBe('signup'); // newest first
    expect(typeof body.has_more).toBe('boolean');
  });

  test('GET /aggregate?metric=count returns the seeded total', async () => {
    const res = await query(`/aggregate?${WINDOW}&metric=count`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metric: string; value: number };
    expect(body.metric).toBe('count');
    expect(body.value).toBe(SEED.length);
  });

  test('GET /funnel converts the seeded view→signup sequence', async () => {
    const res = await query(`/funnel?${WINDOW}&steps=view,signup`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: { event_type: string; count: number }[];
      overall_conversion: number;
    };
    expect(body.steps.map((s) => s.event_type)).toEqual(['view', 'signup']);
    expect(body.steps[0]?.count).toBe(1); // admin-1 viewed
    expect(body.steps[1]?.count).toBe(1); // …then signed up within the window
    expect(body.overall_conversion).toBe(1);
  });

  test('GET /attribution is reachable and returns a groups array', async () => {
    // Ingested events carry no attribution, so groups is empty — this asserts the
    // endpoint is mounted and serves the §5.4 shape; per-source correctness lives
    // in the attribution integration suite.
    const res = await query(`/attribution?${WINDOW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { group_by: string; groups: unknown[] };
    expect(body.group_by).toBe('utm_source');
    expect(Array.isArray(body.groups)).toBe(true);
  });

  test('a non-admin caller is denied every query endpoint with a 403', async () => {
    const denyBeacon = createBeacon({
      productId: 'acceptance',
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => false,
      flushInterval: 60_000,
    });
    const app = new Hono();
    app.route(denyBeacon.basePath, denyBeacon.router());
    const denyServer = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      for (const path of [
        '/schema',
        '/events',
        '/aggregate',
        '/funnel?steps=a,b',
        '/attribution',
      ]) {
        const res = await fetch(`http://localhost:${denyServer.port}/analytics${path}`);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
      }
    } finally {
      denyServer.stop(true);
      await denyBeacon.shutdown();
    }
  }, 15_000);
});
