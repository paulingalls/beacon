import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { type Beacon, createBeacon } from '../src/createBeacon';

// In-process wiring proof for story-004: beacon.track() + beacon.router() are
// exposed on the public API and feed the same EventBuffer. Postgres is
// intentionally unreachable, so flushes fail and events stay buffered — we
// assert wiring through beacon.stats().buffered, no database required. The
// live-DB round-trip is the capstone (story-005).

// Track open instances so each test's buffer timer + token sweep are cleaned up.
const open: Beacon[] = [];
function makeBeacon(overrides: Record<string, unknown> = {}): Beacon {
  const beacon = createBeacon({
    productId: 'wiring-test',
    postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    flushInterval: 60_000, // keep the flush timer quiet for the test's duration
    ...overrides,
  });
  open.push(beacon);
  return beacon;
}

afterEach(async () => {
  while (open.length) await open.pop()?.shutdown();
}, 15_000);

/** POST a JSON event batch. */
function postEvents(app: Hono, path: string, events: unknown[]): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    }),
  );
}

describe('beacon.track() wiring', () => {
  test('buffers a custom event from a route handler', async () => {
    const beacon = makeBeacon();
    const app = new Hono();
    // No middleware mounted, so only the track() event reaches the buffer.
    app.get('/do', (c) => {
      beacon.track(c, 'did_thing', { n: 1 });
      return c.text('ok');
    });

    expect(beacon.stats().buffered).toBe(0);
    const res = await app.request('/do');
    expect(res.status).toBe(200);
    expect(beacon.stats().buffered).toBe(1);
  });
});

describe('beacon.router() wiring', () => {
  test('exposes basePath defaulting to /analytics', () => {
    expect(makeBeacon().basePath).toBe('/analytics');
  });

  test('serves the ingest route at {basePath}/events when mounted at basePath', async () => {
    const beacon = makeBeacon();
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());

    const res = await postEvents(app, `${beacon.basePath}/events`, [
      { event_type: 'a' },
      { event_type: 'b' },
    ]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, product_id_used: 'wiring-test' });
    expect(beacon.stats().buffered).toBe(2);
  });

  test('honors a configured basePath', async () => {
    const beacon = makeBeacon({ basePath: '/metrics' });
    expect(beacon.basePath).toBe('/metrics');
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());

    const res = await postEvents(app, '/metrics/events', [{ event_type: 'x' }]);
    expect(res.status).toBe(202);
    expect(beacon.stats().buffered).toBe(1);
  });

  test('accepts ingest without an authenticated user (public, only rate-limited)', async () => {
    const beacon = makeBeacon(); // no getUserId configured
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());

    const res = await postEvents(app, '/analytics/events', [{ event_type: 'anon' }]);
    expect(res.status).toBe(202);
  });
});

describe('beacon end-to-end wiring (no DB)', () => {
  test('middleware + router + track() all feed the same buffer', async () => {
    const beacon = makeBeacon();
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.route(beacon.basePath, beacon.router());
    app.get('/page', (c) => {
      beacon.track(c, 'page_action', {});
      return c.text('hi');
    });

    await app.request('/page'); // middleware request event + track event = 2
    await postEvents(app, '/analytics/events', [{ event_type: 'e1' }, { event_type: 'e2' }]); // middleware request + 2 ingest = 3

    expect(beacon.stats().buffered).toBe(5);
  });
});
