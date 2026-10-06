import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createHttpBeacon } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';
import { withTestDb } from '../../apps/server/test/helpers';

registerDbCoverageGuard();
const U = 'cutoff/user';
const HASH = createHash('sha256').update(U).digest('hex');
const LOCK = 671007;

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('database ordering condition did not arrive');
    await Bun.sleep(5);
  }
}

describe.skipIf(!TEST_DB)('erasure cutoff socket', () => {
  const getDb = withTestDb(TEST_DB as string);
  beforeEach(async () => {
    await getDb()`TRUNCATE beacon_erasures`;
  });

  function fixture(excludeCapture = false) {
    const beacon = createBeacon({
      productId: 'capture',
      postgres: { connectionString: TEST_DB as string },
      trustedIngestToken: 'secret',
      flushInterval: 60_000,
      maxBatchSize: 100,
      getUserId: () => null,
      ...(excludeCapture ? { excludePaths: ['/analytics'] } : {}),
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.route(beacon.basePath, beacon.router());
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const url = `http://localhost:${server.port}${beacon.basePath}`;
    return {
      beacon,
      url,
      post: async (events: unknown[]) => {
        const res = await fetch(`${url}/events`, {
          method: 'POST',
          headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
          body: JSON.stringify({ product_id: 'business', events }),
        });
        expect(res.status).toBe(202);
      },
      erase: () =>
        fetch(`${url}/users/${encodeURIComponent(U)}/events`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer secret' },
        }),
      close: async () => {
        server.stop(true);
        await beacon.shutdown();
      },
    };
  }

  test('producer queue, inclusive cutoff and mixed accounting admit only later activity', async () => {
    const sql = getDb();
    const f = fixture();
    const producer = createHttpBeacon({
      productId: 'business',
      endpoint: `${f.url}/events`,
      trustedIngestToken: 'secret',
      getUserId: () => U,
      flushInterval: 60_000,
      maxBatchSize: 100,
    });
    const req = new Request('http://producer/visit');
    try {
      await f.post([{ event_type: 'kept', user_id: U }]);
      await f.beacon.flush();
      producer.track(req, 'queued-old');
      const upper = new Date();
      await until(async () => (await sql`SELECT clock_timestamp() > ${upper} AS ready`)[0]?.ready);
      const res = await f.erase();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count: 1 });
      const audit = await sql`SELECT * FROM beacon_erasures WHERE user_id_hash = ${HASH}`;
      expect(audit).toHaveLength(1);
      expect(Number(audit[0]?.count)).toBe(1);
      await producer.flush();
      await f.beacon.flush();
      expect(await sql`SELECT * FROM beacon_events WHERE event_type = 'queued-old'`).toHaveLength(
        0,
      );
      expect([...(await sql`SELECT * FROM beacon_erasures`)]).toEqual([...audit]);
      await until(
        async () => (await sql`SELECT clock_timestamp() > ${new Date()} AS ready`)[0]?.ready,
      );
      producer.track(req, 'later');
      await producer.flush();
      await f.beacon.flush();
      expect(
        await sql`SELECT * FROM beacon_events WHERE user_id = ${U} AND event_type = 'later'`,
      ).toHaveLength(1);

      const cutoff = new Date(Date.now() - 1000);
      await sql`UPDATE beacon_erasures SET erased_at = ${cutoff} WHERE user_id_hash = ${HASH}`;
      const before = f.beacon.stats();
      await f.post([
        { event_type: 'refused-only', user_id: U, timestamp: new Date(+cutoff - 1) },
        { event_type: 'refused-only', user_id: U, timestamp: cutoff },
        { event_type: 'kept', user_id: U, timestamp: new Date(+cutoff + 1) },
        { event_type: 'kept' },
        { event_type: 'kept', user_id: 'other' },
        { event_type: 'unstamped', user_id: U },
      ]);
      await f.beacon.flush();
      const rows =
        await sql`SELECT * FROM beacon_events WHERE product_id = 'business' ORDER BY event_type, user_id NULLS FIRST`;
      expect(rows.map((r) => [r.event_type, r.user_id])).toEqual([
        ['kept', null],
        ['kept', U],
        ['kept', 'other'],
        ['later', U],
        ['unstamped', U],
      ]);
      expect(rows.find((r) => r.event_type === 'kept' && r.user_id === U)?.timestamp).toEqual(
        new Date(+cutoff + 1),
      );
      expect(+rows.find((r) => r.event_type === 'unstamped')?.timestamp).toBeGreaterThan(+cutoff);
      const meta =
        await sql`SELECT * FROM beacon_meta WHERE product_id = 'business' ORDER BY event_type`;
      expect(meta.map((r) => [r.event_type, Number(r.count)])).toEqual([
        ['kept', 4],
        ['later', 1],
        ['unstamped', 1],
      ]);
      expect(meta[0]?.last_seen).toBeInstanceOf(Date);
      expect(f.beacon.stats()).toEqual({ ...before, flushed: before.flushed + 5, buffered: 0 });
    } finally {
      await producer.shutdown();
      await f.close();
    }
  });

  test('all-refused batch leaves no metadata, flushed count or retry', async () => {
    const sql = getDb();
    const f = fixture(true);
    try {
      expect((await f.erase()).status).toBe(200);
      const before = f.beacon.stats();
      await f.post([{ event_type: 'refused', user_id: U, timestamp: new Date(0) }]);
      await f.beacon.flush();
      expect(await sql`SELECT * FROM beacon_events`).toHaveLength(0);
      expect(await sql`SELECT * FROM beacon_meta`).toHaveLength(0);
      expect(f.beacon.stats()).toEqual(before);
      await f.beacon.flush();
      expect(f.beacon.stats()).toEqual(before);
    } finally {
      await f.close();
    }
  });

  for (const writerFirst of [true, false]) {
    test(`concurrent transactions: ${writerFirst ? 'writer' : 'erasure'} first`, async () => {
      const sql = getDb();
      const a = fixture();
      const b = fixture();
      const gate = await sql.reserve();
      const table = writerFirst ? 'beacon_events' : 'beacon_erasures';
      let flush: Promise<void> | undefined;
      let deletion: Promise<Response> | undefined;
      try {
        await gate`SELECT pg_advisory_lock(${LOCK})`;
        await sql.unsafe(`CREATE FUNCTION cutoff_gate() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF ${writerFirst ? "NEW.event_type = 'blocked'" : `NEW.user_id_hash = '${HASH}'`} THEN
            PERFORM pg_advisory_xact_lock(${LOCK});
          END IF; RETURN NEW; END $$`);
        await sql.unsafe(
          `CREATE TRIGGER cutoff_gate BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION cutoff_gate()`,
        );
        const waitingGate = () =>
          sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK} AND NOT granted`.then(
            (r) => r.length > 0,
          );
        const waitingRelation = () =>
          sql`SELECT 1 FROM pg_locks WHERE relation = 'beacon_events'::regclass AND NOT granted`.then(
            (r) => r.length > 0,
          );
        if (writerFirst) {
          await a.post([{ event_type: 'blocked', user_id: U, timestamp: new Date(0) }]);
          flush = a.beacon.flush();
          await until(waitingGate);
          deletion = b.erase();
          await until(
            async () =>
              (await waitingRelation()) || (await sql`SELECT 1 FROM beacon_erasures`).length > 0,
          );
        } else {
          deletion = b.erase();
          await until(waitingGate);
          await a.post([{ event_type: 'blocked', user_id: U, timestamp: new Date(0) }]);
          flush = a.beacon.flush();
          await until(
            async () =>
              (await waitingRelation()) ||
              (await sql`SELECT 1 FROM beacon_events WHERE user_id = ${U}`).length > 0,
          );
        }
        await gate`SELECT pg_advisory_unlock(${LOCK})`;
        const res = await deletion;
        await flush;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ count: writerFirst ? 1 : 0 });
        expect(
          await sql`SELECT 1 FROM beacon_events e JOIN beacon_erasures x ON x.user_id_hash = ${HASH} WHERE e.user_id = ${U} AND e.timestamp <= x.erased_at`,
        ).toHaveLength(0);
        if (!writerFirst) {
          expect(await sql`SELECT * FROM beacon_meta WHERE product_id = 'business'`).toHaveLength(
            0,
          );
          expect(a.beacon.stats()).toEqual({
            buffered: 0,
            flushed: 1,
            dropped: 0,
            retryFailures: 0,
          });
        }
      } finally {
        await gate`SELECT pg_advisory_unlock(${LOCK})`;
        gate.release();
        await Promise.all([flush, deletion]);
        await sql.unsafe(`DROP TRIGGER IF EXISTS cutoff_gate ON ${table}`);
        await sql`DROP FUNCTION IF EXISTS cutoff_gate()`;
        await a.close();
        await b.close();
      }
    }, 10_000);
  }
});
