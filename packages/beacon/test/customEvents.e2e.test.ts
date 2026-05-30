import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { type Beacon, createBeacon } from '../src/index';
import { withTestDb } from './helpers';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Capstone for Milestone 4 (Custom Events): proves the track() helper (story-001),
// the §5.5 errors + rate limiter (story-002), the ingest endpoint (story-003), and
// the public wiring (story-004) compose end to end — both custom-event paths feed
// one EventBuffer and land in beacon_events — and that §1.3 host-resilience holds.

// Track open instances so each test's buffer timer + token sweep are cleaned up.
const open: Beacon[] = [];
function makeBeacon(connectionString: string): Beacon {
  const beacon = createBeacon({
    productId: 'beacon-test',
    postgres: { connectionString },
    flushInterval: 60_000, // keep the flush timer quiet for the test's duration
  });
  open.push(beacon);
  return beacon;
}

afterEach(async () => {
  while (open.length) await open.pop()?.shutdown();
}, 15_000);

/** Hono app mounting both custom-event paths plus a handler that calls track(). */
function appWith(beacon: Beacon): Hono {
  const app = new Hono();
  app.use('*', beacon.middleware());
  app.route(beacon.basePath, beacon.router());
  app.get('/buy', (c) => {
    beacon.track(c, 'purchase', { amount: 9 });
    return c.text('ok');
  });
  return app;
}

/** POST an event batch to the mounted ingest route. */
function postBatch(
  app: Hono,
  events: unknown[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request('/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ events }),
    }),
  );
}

describe('Capstone — custom events resilience (no Postgres)', () => {
  test('track() and ingest both succeed and never crash the host with Postgres down (§1.3)', async () => {
    const beacon = makeBeacon('postgres://u:p@127.0.0.1:1/db');
    const app = appWith(beacon);

    const buy = await app.request('/buy');
    expect(buy.status).toBe(200);

    const ingest = await postBatch(app, [
      { event_type: 'screen_view' },
      { event_type: 'button_tap' },
    ]);
    expect(ingest.status).toBe(202);
    expect(await ingest.json()).toEqual({ accepted: 2 });

    // request(/buy) + track + request(/analytics/events) + 2 ingest = 5, all surviving
    // the unreachable DB (fire-and-forget; the failed flush re-queues, never drops here).
    expect(beacon.stats().buffered).toBe(5);
  }, 15_000);
});

describe.skipIf(!TEST_DB)('Capstone — custom events round-trip (live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  test('track() + POST ingest land in beacon_events with the right type/properties/product_id/platform', async () => {
    const migrator = getDb();
    const beacon = makeBeacon(TEST_DB as string);
    const app = appWith(beacon);

    // Server-side track() from a handler, carrying mobile app-context (platform ios).
    await app.request('/buy', {
      headers: { 'x-app-context': JSON.stringify({ platform: 'ios' }) },
    });
    // Client batch ingest, no app-context → platform inferred as 'web'.
    await postBatch(app, [
      { event_type: 'screen_view', properties: { screen: 'Home' } },
      { event_type: 'button_tap', properties: { button: 'buy' } },
    ]);
    await beacon.flush(); // one flush drains all (<= 5 events, under maxBatchSize 100)

    // The server-side track event.
    const purchase = await migrator<
      { properties: { amount?: number }; product_id: string; platform: string }[]
    >`SELECT properties, product_id, platform FROM beacon_events WHERE event_type = 'purchase'`;
    expect(purchase.length).toBe(1);
    expect(purchase[0]?.properties).toEqual({ amount: 9 });
    expect(purchase[0]?.product_id).toBe('beacon-test');
    expect(purchase[0]?.platform).toBe('ios'); // from /buy's X-App-Context

    // The two ingested events — queried by type so the assertion is order-independent.
    const batch = await migrator<
      {
        event_type: string;
        screen: string | null;
        button: string | null;
        platform: string;
        product_id: string;
      }[]
    >`
      SELECT event_type, properties->>'screen' AS screen, properties->>'button' AS button,
             platform, product_id
      FROM beacon_events WHERE event_type IN ('screen_view', 'button_tap')`;
    expect(batch.length).toBe(2);
    const byType = Object.fromEntries(batch.map((r) => [r.event_type, r]));
    expect(byType.screen_view?.screen).toBe('Home');
    expect(byType.button_tap?.button).toBe('buy');
    expect(batch.every((r) => r.product_id === 'beacon-test')).toBe(true);
    // No X-App-Context on the POST → both ingest events default to platform 'web',
    // confirming context is inferred per request (distinct from the 'ios' track above).
    expect(batch.every((r) => r.platform === 'web')).toBe(true);
  });
});
