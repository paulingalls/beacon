import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { withTestDb } from '../test/helpers';
import { type BeaconConfig, createBeacon } from './index';

const TEST_DB = process.env.TEST_DATABASE_URL;

const baseConfig = (overrides: Partial<BeaconConfig> = {}): BeaconConfig => ({
  productId: 'beacon-test',
  postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
  ...overrides,
});

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
    expect(typeof beacon.middleware).toBe('function');
    expect(typeof beacon.stats).toBe('function');
    expect(typeof beacon.flush).toBe('function');
    expect(typeof beacon.shutdown).toBe('function');
    expect(beacon.stats().buffered).toBe(0);
    // Fire-and-forget cleanup: shutdown() clears the flush timer synchronously
    // (buffer.stop) so no timer leaks; the unreachable closeDb drains in the
    // background. The .catch() prevents an unhandled rejection if sql.end()
    // rejects on the unreachable host. The reachable shutdown path is asserted
    // in the integration suite, where closeDb returns promptly.
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
