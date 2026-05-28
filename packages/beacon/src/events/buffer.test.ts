import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { Sql } from 'postgres';

import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import type { BeaconEvent } from '../types';
import { EventBuffer } from './buffer';

const TEST_DB = process.env.TEST_DATABASE_URL;

const evt = (overrides: Partial<BeaconEvent> = {}): BeaconEvent => ({
  productId: 'beacon-test',
  eventType: 'request',
  ...overrides,
});

/**
 * Minimal stub standing in for postgres.js `Sql`. It is both callable as a
 * tagged template and as the `sql(rows)` insert helper, and exposes `.begin()`.
 * `failBegins` makes the first N transactions reject, simulating write failures
 * so the retry path is exercised without a live database.
 */
function makeStubSql(opts: { failBegins?: number } = {}): {
  sql: Sql;
  beginCalls: () => number;
} {
  let begins = 0;
  // Callable as both `tx`...`` and `tx(rows)`; the buffer only needs the calls
  // to resolve, so the return value is inert. Built untyped, then cast to Sql —
  // typing `.begin` against the real (TransactionSql) signature isn't needed.
  const tx = (() => Promise.resolve([])) as unknown as Sql;
  const base = (() => Promise.resolve([])) as unknown as Record<string, unknown> &
    (() => Promise<unknown>);
  // The buffer wraps jsonb values via sql.json(); the stub passes them through.
  base.json = (value: unknown) => value;
  base.begin = async (fn: (t: Sql) => Promise<unknown>) => {
    begins += 1;
    if (opts.failBegins && begins <= opts.failBegins) {
      throw new Error('simulated write failure');
    }
    return fn(tx);
  };
  return { sql: base as unknown as Sql, beginCalls: () => begins };
}

describe('EventBuffer (unit, stub Sql)', () => {
  test('drops events silently and counts them once at maxBufferSize', () => {
    const { sql } = makeStubSql();
    // maxBatchSize far above the pushes so the size-trigger never fires —
    // isolates backpressure behavior.
    const buffer = new EventBuffer(sql, { maxBufferSize: 3, maxBatchSize: 100 });

    for (let i = 0; i < 5; i++) buffer.push(evt());

    const stats = buffer.stats();
    expect(stats.buffered).toBe(3);
    expect(stats.dropped).toBe(2);
  });

  test('flush writes one batch up to maxBatchSize per call', async () => {
    const { sql } = makeStubSql();
    const buffer = new EventBuffer(sql, { maxBufferSize: 100, maxBatchSize: 3 });

    for (let i = 0; i < 5; i++) buffer.push(evt());
    expect(buffer.stats().buffered).toBe(5);

    await buffer.flush();
    expect(buffer.stats().flushed).toBe(3);
    expect(buffer.stats().buffered).toBe(2);

    await buffer.flush();
    expect(buffer.stats().flushed).toBe(5);
    expect(buffer.stats().buffered).toBe(0);
  });

  test('reaching maxBatchSize while started triggers an immediate flush', async () => {
    const { sql, beginCalls } = makeStubSql();
    // Long interval so the timer never fires within the test — only the
    // size-trigger can cause the flush.
    const buffer = new EventBuffer(sql, {
      maxBufferSize: 100,
      maxBatchSize: 2,
      flushInterval: 60_000,
    });
    buffer.start();
    try {
      buffer.push(evt());
      buffer.push(evt()); // reaches maxBatchSize -> fire-and-forget flush
      // Let the fire-and-forget flush settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(beginCalls()).toBeGreaterThanOrEqual(1);
      expect(buffer.stats().flushed).toBe(2);
      expect(buffer.stats().buffered).toBe(0);
    } finally {
      await buffer.stop();
    }
  });

  test('retries on write failure and drops the batch after the 3rd failure', async () => {
    const { sql } = makeStubSql({ failBegins: 3 });
    const buffer = new EventBuffer(sql, { maxBufferSize: 100, maxBatchSize: 10 });

    for (let i = 0; i < 3; i++) buffer.push(evt());

    await buffer.flush(); // failure 1 -> requeue
    expect(buffer.stats().buffered).toBe(3);
    await buffer.flush(); // failure 2 -> requeue
    expect(buffer.stats().buffered).toBe(3);
    await buffer.flush(); // failure 3 -> drop

    const stats = buffer.stats();
    expect(stats.buffered).toBe(0);
    expect(stats.retryFailures).toBe(3);
    expect(stats.flushed).toBe(0);
    expect(stats.dropped).toBe(0); // retry-exhaustion is counted separately
  });

  test('a recovered write after retries flushes the batch (no loss)', async () => {
    const { sql } = makeStubSql({ failBegins: 1 });
    const buffer = new EventBuffer(sql, { maxBufferSize: 100, maxBatchSize: 10 });

    for (let i = 0; i < 2; i++) buffer.push(evt());

    await buffer.flush(); // fails -> requeue
    expect(buffer.stats().buffered).toBe(2);
    await buffer.flush(); // succeeds
    expect(buffer.stats().flushed).toBe(2);
    expect(buffer.stats().buffered).toBe(0);
    expect(buffer.stats().retryFailures).toBe(0);
  });

  test('flush on an empty buffer is a no-op', async () => {
    const { sql, beginCalls } = makeStubSql();
    const buffer = new EventBuffer(sql, {});
    await buffer.flush();
    expect(beginCalls()).toBe(0);
    expect(buffer.stats().flushed).toBe(0);
  });
});

/**
 * Like makeStubSql, but each `begin()` blocks until the gate is opened — letting
 * a flush sit in-flight while stop() runs. openGate() releases all pending and
 * future transactions, so the test settles deterministically (no timers/sleeps).
 */
function makeGatedStubSql(): { sql: Sql; openGate: () => void } {
  let open = false;
  const pending: Array<() => void> = [];
  const tx = (() => Promise.resolve([])) as unknown as Sql;
  const base = (() => Promise.resolve([])) as unknown as Record<string, unknown> &
    (() => Promise<unknown>);
  base.json = (value: unknown) => value;
  base.begin = (fn: (t: Sql) => Promise<unknown>) =>
    new Promise((resolve, reject) => {
      const run = () => {
        Promise.resolve()
          .then(() => fn(tx))
          .then(resolve, reject);
      };
      if (open) run();
      else pending.push(run);
    });
  const openGate = () => {
    open = true;
    while (pending.length > 0) pending.shift()?.();
  };
  return { sql: base as unknown as Sql, openGate };
}

describe('EventBuffer (concurrency, stub Sql)', () => {
  test('stop() awaits an in-flight flush and then drains the remainder (no loss)', async () => {
    const { sql, openGate } = makeGatedStubSql();
    const buffer = new EventBuffer(sql, { maxBufferSize: 100, maxBatchSize: 2 });
    for (let i = 0; i < 3; i++) buffer.push(evt());

    // First flush takes a batch of 2 and blocks at the gate, leaving 1 queued.
    const flushP = buffer.flush();
    // stop() must wait for that in-flight flush, then flush the remaining event.
    const stopP = buffer.stop();
    openGate();
    await Promise.all([flushP, stopP]);

    // Without awaiting the in-flight flush, stop() would strand the 3rd event.
    expect(buffer.stats().flushed).toBe(3);
    expect(buffer.stats().buffered).toBe(0);
  });

  test('concurrent flush() calls coalesce onto one in-flight write', async () => {
    const { sql, openGate } = makeGatedStubSql();
    const buffer = new EventBuffer(sql, { maxBufferSize: 100, maxBatchSize: 100 });
    for (let i = 0; i < 4; i++) buffer.push(evt());

    const a = buffer.flush();
    const b = buffer.flush(); // coalesces — does not start a second batch
    expect(a).toBe(b);
    openGate();
    await Promise.all([a, b]);

    expect(buffer.stats().flushed).toBe(4);
    expect(buffer.stats().buffered).toBe(0);
  });
});

describe.skipIf(!TEST_DB)('EventBuffer (integration, live Postgres)', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE beacon_events, beacon_meta`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  });

  test('flushes events across two (product_id,event_type) pairs and upserts beacon_meta', async () => {
    const buffer = new EventBuffer(sql, { maxBatchSize: 100 });
    buffer.push(evt({ eventType: 'request', properties: { path: '/a' } }));
    buffer.push(evt({ eventType: 'request', properties: { path: '/b' } }));
    buffer.push(evt({ eventType: 'screen_view', properties: { name: 'Home' } }));

    await buffer.flush();
    expect(buffer.stats().flushed).toBe(3);

    const events = await sql<{ event_type: string; properties: Record<string, unknown> }[]>`
      SELECT event_type, properties FROM beacon_events ORDER BY event_type`;
    expect(events).toHaveLength(3);

    const meta = await sql<{ event_type: string; count: string; last_seen: Date }[]>`
      SELECT event_type, count, last_seen FROM beacon_meta
      WHERE product_id = 'beacon-test' ORDER BY event_type`;
    const byType = new Map(meta.map((m) => [m.event_type, m]));
    expect(Number(byType.get('request')?.count)).toBe(2);
    expect(Number(byType.get('screen_view')?.count)).toBe(1);
    expect(byType.get('request')?.last_seen).toBeInstanceOf(Date);
  });

  test('a second flush increments existing beacon_meta counts (ON CONFLICT)', async () => {
    const buffer = new EventBuffer(sql, { maxBatchSize: 100 });
    buffer.push(evt({ eventType: 'request' }));
    await buffer.flush();
    buffer.push(evt({ eventType: 'request' }));
    buffer.push(evt({ eventType: 'request' }));
    await buffer.flush();

    const metaRows = await sql<{ count: string }[]>`
      SELECT count FROM beacon_meta WHERE product_id = 'beacon-test' AND event_type = 'request'`;
    expect(Number(metaRows[0]?.count)).toBe(3);
    expect(buffer.stats().flushed).toBe(3);
  });

  test('jsonb columns round-trip object properties', async () => {
    const buffer = new EventBuffer(sql, {});
    buffer.push(evt({ eventType: 'request', properties: { nested: { a: 1 }, list: [1, 2] } }));
    await buffer.flush();

    const [row] = await sql<{ properties: Record<string, unknown> }[]>`
      SELECT properties FROM beacon_events LIMIT 1`;
    expect(row?.properties).toEqual({ nested: { a: 1 }, list: [1, 2] });
  });
});
