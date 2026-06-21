import { describe, expect, test } from 'bun:test';
import type { BeaconEvent } from '@pi-innovations/beacon';
import { EventBuffer } from '@pi-innovations/beacon/internal/events/buffer';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../../packages/beacon/test/dbGuard';
import { stubSql, withTestDb } from '../../../packages/beacon/test/helpers';
import { createBeacon } from '../src/createBeacon';

registerDbCoverageGuard();

const evt = (overrides: Partial<BeaconEvent> = {}): BeaconEvent => ({
  productId: 'beacon-test',
  eventType: 'request',
  ...overrides,
});

// Capstone for Milestone 2: proves the buffer (story-001), middleware
// (story-002), and createBeacon factory (story-003) compose, and that §1.3
// failure isolation holds end to end.

describe('Capstone — failure isolation (no Postgres)', () => {
  test('Beacon never crashes the host when Postgres is unreachable, and buffers events', async () => {
    // Well-formed but unreachable — createDb returns a real lazy client whose
    // queries reject on use; the host must be unaffected.
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/x', (c) => c.text('ok'));

    const res = await app.request('/x');
    expect(res.status).toBe(200); // host response unaffected by the outage
    expect(await res.text()).toBe('ok');
    expect(beacon.stats().buffered).toBeGreaterThan(0); // event held in memory

    // A flush against the down DB re-queues rather than throwing.
    await expect(beacon.flush()).resolves.toBeUndefined();

    // shutdown() must resolve cleanly even with Postgres down — the milestone's
    // "Postgres-down never crashes the host" DoD. buffer.stop() drains (writes
    // keep failing, no-progress break), then closeDb closes without rejecting.
    // The generous timeout guards closeDb's worst-case 5s drain bound.
    await expect(beacon.shutdown()).resolves.toBeUndefined();
  }, 15_000);
});

describe.skipIf(!TEST_DB)('Capstone — live Postgres', () => {
  const getDb = withTestDb(TEST_DB as string);

  test('round-trip: a request is logged to Postgres through the full createBeacon surface', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/page', (c) => c.text('hi'));

    const res = await app.request('/page');
    expect(res.status).toBe(200);

    await beacon.flush();
    const rows = await migrator<{ path: string }[]>`
      SELECT properties->>'path' AS path FROM beacon_events WHERE event_type = 'request'`;
    expect(rows.map((r) => r.path)).toContain('/page');

    await beacon.shutdown();
  });

  test('events buffered during a transient outage drain on recovery, with no loss', async () => {
    const migrator = getDb();
    // flakyOnce wraps the live client: the first begin() rejects (simulated
    // outage), subsequent calls delegate to the real connection (recovery).
    const buffer = new EventBuffer(flakyOnce(migrator), { maxBatchSize: 100 });
    buffer.push(evt({ properties: { path: '/r1' } }));
    buffer.push(evt({ properties: { path: '/r2' } }));

    await buffer.flush(); // outage: write fails, batch re-queued to the front
    expect(buffer.stats().buffered).toBe(2);
    expect(buffer.stats().flushed).toBe(0);

    await buffer.flush(); // recovery: writes to the real DB
    expect(buffer.stats().flushed).toBe(2);
    expect(buffer.stats().buffered).toBe(0);

    const rows = await migrator<{ c: number }[]>`
      SELECT count(*)::int AS c FROM beacon_events WHERE event_type = 'request'`;
    expect(rows[0]?.c).toBe(2);
  });
});

/**
 * Wraps a real Sql so the first transaction rejects (a simulated outage), then
 * delegates to the real client — exercising the buffer's re-queue-then-drain
 * recovery path against a real Postgres.
 */
function flakyOnce(realSql: Sql): Sql {
  const real = realSql as unknown as {
    begin: (fn: unknown) => Promise<unknown>;
    json: (value: unknown) => unknown;
  };
  let failedOnce = false;
  return stubSql({
    begin: (fn) => {
      if (!failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error('transient outage'));
      }
      return real.begin(fn);
    },
    json: (value) => real.json(value),
  });
}
