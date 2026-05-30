import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { withTestDb } from '../test/helpers';
import { type BeaconConfig, createBeacon } from './index';

const TEST_DB = process.env.TEST_DATABASE_URL;

const baseConfig = (overrides: Partial<BeaconConfig> = {}): BeaconConfig => ({
  productId: 'beacon-test',
  postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
  ...overrides,
});

/** Minimal Hono context carrying (or not) a visitor token, for unit tests. */
const ctxWith = (token?: string): Context =>
  ({
    get: (key: string) => (key === 'beaconVisitorToken' ? token : undefined),
  }) as unknown as Context;

describe('createBeacon (unit)', () => {
  test('throws when productId is missing', () => {
    expect(() =>
      createBeacon({ productId: '', postgres: { connectionString: 'postgres://x' } }),
    ).toThrow(/productId/);
  });

  test('throws when postgres.connectionString is missing', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing a misconfig the types forbid
    expect(() => createBeacon({ productId: 'p', postgres: {} } as any)).toThrow(/connectionString/);
  });

  test('returns the documented surface, starts the buffer empty, and never throws at construction even with unreachable Postgres (§1.3)', () => {
    // baseConfig points at an unreachable host; createDb never throws, so the
    // factory must construct cleanly without a connectivity gate.
    const beacon = createBeacon(baseConfig());
    expect(beacon.basePath).toBe('/analytics');
    expect(typeof beacon.middleware).toBe('function');
    expect(typeof beacon.track).toBe('function');
    expect(typeof beacon.router).toBe('function');
    expect(typeof beacon.stats).toBe('function');
    expect(typeof beacon.flush).toBe('function');
    expect(typeof beacon.shutdown).toBe('function');
    expect(typeof beacon.getVisitorToken).toBe('function');
    expect(typeof beacon.appendToken).toBe('function');
    expect(typeof beacon.associateVisitor).toBe('function');
    expect(beacon.stats().buffered).toBe(0);
    // Fire-and-forget cleanup: shutdown() clears the flush timer synchronously
    // (buffer.stop) so no timer leaks; the unreachable closeDb drains in the
    // background. The .catch() prevents an unhandled rejection if sql.end()
    // rejects on the unreachable host. The reachable shutdown path is asserted
    // in the integration suite, where closeDb returns promptly.
    void beacon.shutdown().catch(() => {});
  });

  test('getVisitorToken returns the context token, or null when absent', () => {
    const beacon = createBeacon(baseConfig());
    expect(beacon.getVisitorToken(ctxWith('tok123456789'))).toBe('tok123456789');
    expect(beacon.getVisitorToken(ctxWith(undefined))).toBeNull();
    void beacon.shutdown().catch(() => {});
  });

  test('appendToken appends _t with the right separator, preserves fragments, and no-ops without a token', () => {
    const beacon = createBeacon(baseConfig());
    const c = ctxWith('tok123456789');
    expect(beacon.appendToken('/dashboard', c)).toBe('/dashboard?_t=tok123456789');
    expect(beacon.appendToken('/dashboard?ref=1', c)).toBe('/dashboard?ref=1&_t=tok123456789');
    expect(beacon.appendToken('/dashboard#section', c)).toBe('/dashboard?_t=tok123456789#section');
    expect(beacon.appendToken('/dashboard?ref=1#x', c)).toBe('/dashboard?ref=1&_t=tok123456789#x');
    // No token in context → URL is returned unchanged.
    expect(beacon.appendToken('/dashboard', ctxWith(undefined))).toBe('/dashboard');
    // Idempotent: a URL already carrying _t is not double-appended (would split
    // the trail). Holds whether _t is the only param or one of several.
    expect(beacon.appendToken('/dashboard?_t=old', c)).toBe('/dashboard?_t=old');
    expect(beacon.appendToken('/dashboard?ref=1&_t=old#x', c)).toBe('/dashboard?ref=1&_t=old#x');
    void beacon.shutdown().catch(() => {});
  });

  test('associateVisitor with no token in context is a clean no-op (no SQL, no throw)', async () => {
    const beacon = createBeacon(baseConfig());
    await expect(beacon.associateVisitor(ctxWith(undefined), 'user-1')).resolves.toBeUndefined();
    void beacon.shutdown().catch(() => {});
  });

  test('associateVisitor never throws when Postgres is unreachable (§1.3)', async () => {
    // baseConfig is unreachable; the UPDATE rejects, associateVisitor catches it.
    const beacon = createBeacon(baseConfig());
    await expect(
      beacon.associateVisitor(ctxWith('tok123456789'), 'user-1'),
    ).resolves.toBeUndefined();
    void beacon.shutdown().catch(() => {});
  });
});

describe.skipIf(!TEST_DB)('createBeacon (integration, live Postgres)', () => {
  // Shared migrated client; each Beacon under test opens its own client.
  const getDb = withTestDb(TEST_DB as string);

  test('round-trip: middleware on a Hono app logs a request to Postgres after flush', async () => {
    const migrator = getDb();

    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/hello', (c) => c.text('hi'));

    const res = await app.request('/hello');
    expect(res.status).toBe(200);

    await beacon.flush();
    const rows = await migrator<{ path: string }[]>`
      SELECT properties->>'path' AS path FROM beacon_events WHERE event_type = 'request'`;
    expect(rows.map((r) => r.path)).toContain('/hello');

    await beacon.shutdown();
  });

  test('shutdown() drains buffered events before closing the connection', async () => {
    const migrator = getDb();

    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/drain', (c) => c.text('ok'));

    await app.request('/drain');
    expect(beacon.stats().buffered).toBe(1);

    await beacon.shutdown(); // must flush the buffered event before closeDb

    const rows = await migrator<{ count: string }[]>`
      SELECT count(*)::int AS count FROM beacon_events WHERE event_type = 'request'`;
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe.skipIf(!TEST_DB)('associateVisitor (integration, live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  // Drive an anonymous trail through the middleware (mints a token + captures
  // attribution in the beacon's store), flush it, and return the token.
  async function anonymousTrail(beacon: ReturnType<typeof createBeacon>): Promise<string> {
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));

    const first = await app.request('/p?utm_source=newsletter&utm_campaign=spring');
    const token = await first.text();
    // Each request now stamps its own event-time at request start, so a small
    // gap makes the two events' timestamps distinct and the earliest-event
    // attribution assertion deterministic (not dependent on insertion order).
    await Bun.sleep(2);
    await app.request(`/p?_t=${token}`); // second hit reuses the token
    await beacon.flush();
    return token;
  }

  test('back-fills user_id across the trail and writes attribution to the earliest event', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const token = await anonymousTrail(beacon);

    await beacon.associateVisitor(ctxWith(token), 'user-7');

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}
      ORDER BY timestamp ASC, received_at ASC`;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.user_id === 'user-7')).toBe(true); // whole trail associated
    expect(rows[0]?.src).toBe('newsletter'); // attribution on the earliest event
    expect(rows.slice(1).every((r) => r.src === null)).toBe(true); // only the earliest

    await beacon.shutdown();
  });

  test('fast login: associateVisitor flushes the buffer first, so unflushed trail events are still associated', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));

    // Drive a trail but deliberately do NOT flush — events stay in the buffer,
    // simulating a login inside the flush window.
    const first = await app.request('/p?utm_source=newsletter');
    const token = await first.text();
    await Bun.sleep(2);
    await app.request(`/p?_t=${token}`);
    expect(beacon.stats().buffered).toBe(2); // still in memory, not persisted

    await beacon.associateVisitor(ctxWith(token), 'user-11');

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}
      ORDER BY timestamp ASC, received_at ASC`;
    expect(rows.length).toBe(2); // both buffered events were flushed before the UPDATE
    expect(rows.every((r) => r.user_id === 'user-11')).toBe(true);
    expect(rows[0]?.src).toBe('newsletter'); // first-touch attribution preserved

    await beacon.shutdown();
  });

  test('a second associate is a clean no-op — token removed, user_id guarded by IS NULL', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const token = await anonymousTrail(beacon);

    await beacon.associateVisitor(ctxWith(token), 'user-7');
    // Wipe attribution so a re-copy would be detectable, then associate again.
    await migrator`UPDATE beacon_events SET attribution = '{}'::jsonb WHERE visitor_token = ${token}`;
    await beacon.associateVisitor(ctxWith(token), 'user-9');

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src FROM beacon_events WHERE visitor_token = ${token}`;
    expect(rows.every((r) => r.user_id === 'user-7')).toBe(true); // user-9 did NOT clobber (WHERE user_id IS NULL)
    expect(rows.every((r) => r.src === null)).toBe(true); // attribution NOT re-copied (token removed from store)

    await beacon.shutdown();
  });

  test('only the null-user_id rows are associated, leaving already-attributed events untouched', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const token = await anonymousTrail(beacon);
    // Pre-associate one row to a different user; associate must not clobber it.
    await migrator`
      UPDATE beacon_events SET user_id = 'existing-user'
      WHERE event_id = (SELECT event_id FROM beacon_events WHERE visitor_token = ${token} ORDER BY timestamp DESC LIMIT 1)`;

    await beacon.associateVisitor(ctxWith(token), 'user-7');

    const rows = await migrator<{ user_id: string }[]>`
      SELECT user_id FROM beacon_events WHERE visitor_token = ${token}`;
    const ids = rows.map((r) => r.user_id).sort();
    expect(ids).toContain('existing-user'); // untouched
    expect(ids).toContain('user-7'); // the null row got associated

    await beacon.shutdown();
  });
});
