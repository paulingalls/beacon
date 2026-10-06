import { describe, expect, test } from 'bun:test';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';
import { stubSql, txResolver, withTestDb } from '../../test/helpers';
import { EventBuffer } from './buffer';

registerDbCoverageGuard();

const evt = (overrides: Partial<BeaconEvent> = {}): BeaconEvent => ({
  productId: 'beacon-test',
  eventType: 'request',
  ...overrides,
});

/**
 * A stub Sql whose first `failBegins` transactions reject (simulating write
 * failures) so the buffer's retry path is exercised without a live database.
 */
function makeStubSql(opts: { failBegins?: number } = {}): {
  sql: Sql;
  beginCalls: () => number;
} {
  let begins = 0;
  const sql = stubSql({
    begin: async (fn) => {
      begins += 1;
      if (opts.failBegins && begins <= opts.failBegins) {
        throw new Error('simulated write failure');
      }
      return fn(txResolver);
    },
  });
  return { sql, beginCalls: () => begins };
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
  const sql = stubSql({
    begin: (fn) =>
      new Promise((resolve, reject) => {
        const run = () => {
          Promise.resolve()
            .then(() => fn(txResolver))
            .then(resolve, reject);
        };
        if (open) run();
        else pending.push(run);
      }),
  });
  const openGate = () => {
    open = true;
    while (pending.length > 0) pending.shift()?.();
  };
  return { sql, openGate };
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
  const getDb = withTestDb(TEST_DB as string);

  test('jsonb columns round-trip object properties', async () => {
    const sql = getDb();
    const buffer = new EventBuffer(sql, {});
    buffer.push(evt({ eventType: 'request', properties: { nested: { a: 1 }, list: [1, 2] } }));
    await buffer.flush();

    const [row] = await sql<{ properties: Record<string, unknown> }[]>`
      SELECT properties FROM beacon_events LIMIT 1`;
    expect(row?.properties).toEqual({ nested: { a: 1 }, list: [1, 2] });
  });
});

describe('purgeUser', () => {
  function fixture(fail = false) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    let first = true;
    const tx = ((rows: unknown) => {
      if (Array.isArray(rows) && rows[0]?.user_id !== undefined) {
        written.push(...rows.map((row) => row.user_id));
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    const sql = stubSql({
      begin: async (fn) => {
        if (first) {
          first = false;
          await gate;
          if (fail) throw new Error('write failed');
        }
        return fn(tx);
      },
    });
    return { buffer: new EventBuffer(sql, { maxBatchSize: 100 }), written, release };
  }

  test('purgeUser discards more than ten queued batches only for U', async () => {
    const { buffer, written, release } = fixture();
    for (let i = 0; i < 1001; i++) buffer.push(evt({ userId: 'U' }));
    buffer.push(evt({ userId: 'V' }));
    await buffer.purgeUser('U');
    expect(buffer.stats().buffered).toBe(1);
    release();
    await buffer.stop();
    expect(written).toEqual(['V']);
    buffer.push(evt({ userId: 'U' }));
    await buffer.flush();
    expect(written).toEqual(['V', 'U']);
  });

  for (const fail of [false, true]) {
    test(
      fail
        ? 'purgeUser discards U from a failed in-flight batch'
        : 'purgeUser awaits a successful in-flight U write',
      async () => {
        const { buffer, written, release } = fixture(fail);
        buffer.push(evt({ userId: 'U' }));
        buffer.push(evt({ userId: 'V' }));
        const flush = buffer.flush();
        buffer.push(evt({ userId: 'U' }));
        buffer.push(evt({ userId: 'W' }));
        let settled = false;
        const purge = buffer.purgeUser('U').then(() => {
          settled = true;
        });
        const otherPurge = buffer.purgeUser('W');
        try {
          await Promise.resolve();
          expect(settled).toBe(false);
        } finally {
          release();
          await Promise.all([flush, purge, otherPurge]);
        }
        await buffer.stop();
        expect(written).toEqual(fail ? ['V'] : ['U', 'V']);
        expect(buffer.stats().retryFailures).toBe(0);
        expect(buffer.stats().dropped).toBe(0);
      },
    );
  }
});
