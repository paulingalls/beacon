import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
import { EventBuffer } from '../../apps/server/src/events/buffer';
import type { BeaconConfig } from '../../apps/server/src/types';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';
import { withTestDb } from '../../apps/server/test/helpers';

registerDbCoverageGuard();
const U = 'socket/user private';
const V = 'retained-socket-user';
const HASH = createHash('sha256').update(U).digest('hex');
const LOCK = 671006;

describe.skipIf(!TEST_DB)('erasure socket', () => {
  const getDb = withTestDb(TEST_DB as string);

  async function fixture(opts: Partial<BeaconConfig> = {}) {
    const sql = getDb();
    await sql`TRUNCATE beacon_erasures`;
    const beacon = createBeacon({
      productId: 'erase',
      postgres: { connectionString: TEST_DB as string },
      basePath: '/private-analytics',
      trustedIngestToken: 'secret',
      flushInterval: 60_000,
      maxBatchSize: 100,
      getUserId: () => null,
      excludePaths: ['/private-analytics'],
      ...opts,
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/visit', (c) => c.json({ token: beacon.getVisitorToken(c) }));
    app.route(beacon.basePath, beacon.router());
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const url = `http://localhost:${server.port}${beacon.basePath}`;
    let requestNumber = 0;
    async function post(path: string, body: unknown) {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
          'x-forwarded-for': `192.0.2.${++requestNumber}`,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(path === '/identify' ? 204 : 202);
      return res;
    }
    const erase = (authorization = 'Bearer secret') =>
      fetch(`${url}/users/${encodeURIComponent(U)}/events`, {
        method: 'DELETE',
        headers: { authorization },
      });
    async function drain() {
      while (beacon.stats().buffered) await beacon.flush();
    }
    return {
      sql,
      beacon,
      url,
      post,
      erase,
      drain,
      visit: () => fetch(`http://localhost:${server.port}/visit`),
      close: async () => {
        server.stop(true);
        await beacon.shutdown();
      },
    };
  }

  test('erasure bypasses default request logging on success and refusal', async () => {
    for (const kind of ['trusted', 'refused', 'throwing user resolver']) {
      const f = await fixture({
        excludePaths: [],
        getUserId: () => {
          if (kind === 'throwing user resolver') throw new Error(U);
          return U;
        },
      });
      const logs = [spyOn(console, 'warn'), spyOn(console, 'error'), spyOn(console, 'log')].map(
        (spy) => spy.mockImplementation(() => {}),
      );
      try {
        await f.sql`INSERT INTO beacon_events (product_id, event_type, user_id) VALUES ('erase', 'stored', ${U})`;
        const before = f.beacon.stats();
        const res = await f.erase(kind === 'refused' ? '' : 'Bearer secret');
        expect(res.status).toBe(kind === 'refused' ? 403 : 200);
        expect(f.beacon.stats()).toEqual(before);
        await f.beacon.flush();
        expect(await f.sql`SELECT * FROM beacon_events WHERE user_id = ${U}`).toHaveLength(
          kind === 'refused' ? 1 : 0,
        );
        expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(U);
        if (kind !== 'throwing user resolver') {
          await f.visit();
          expect(f.beacon.stats().buffered).toBe(1);
        }
      } finally {
        await f.close();
        for (const log of logs) log.mockRestore();
      }
      await f.sql`TRUNCATE beacon_events, beacon_meta`;
    }
  });

  for (const fail of [true, false]) {
    test(fail
      ? 'erasure roundtrip defeats drain and failed requeue'
      : 'erasure roundtrip waits for successful in-flight commit', async () => {
      const f = await fixture();
      const lock = await f.sql.reserve();
      let released = false;
      let flush: Promise<void> | undefined;
      let deletion: Promise<Response> | undefined;
      const spies: Array<{ mockRestore(): void }> = [];
      const logs = [spyOn(console, 'warn'), spyOn(console, 'error'), spyOn(console, 'log')].map(
        (spy) => spy.mockImplementation(() => {}),
      );
      try {
        const visitor = (await (await f.visit()).json()) as { token: string };
        await f.beacon.flush();
        await f.post('/identify', { visitor_token: visitor.token, user_id: U });
        expect(
          await f.sql`SELECT * FROM beacon_events WHERE user_id = ${U} AND visitor_token = ${visitor.token}`,
        ).toHaveLength(1);
        await f.post('/events', {
          product_id: 'another-product',
          events: [
            { event_type: 'stored', user_id: U },
            { event_type: 'stored', user_id: V },
          ],
        });
        await f.beacon.flush();
        const retained = await f.sql`SELECT * FROM beacon_events WHERE user_id = ${V}`;
        const [{ count }] = await f.sql`SELECT count(*) FROM beacon_events WHERE user_id = ${U}`;
        await lock`SELECT pg_advisory_lock(${LOCK})`;
        await f.sql.unsafe(`CREATE FUNCTION erasure_block() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.event_type = 'blocked' THEN
            PERFORM pg_advisory_xact_lock(${LOCK});
            ${fail ? "RAISE EXCEPTION 'private write failed';" : ''}
          END IF; RETURN NEW; END $$`);
        await f.sql`CREATE TRIGGER erasure_block BEFORE INSERT ON beacon_events FOR EACH ROW EXECUTE FUNCTION erasure_block()`;
        await f.post('/events', {
          events: [
            { event_type: 'blocked', user_id: U },
            { event_type: 'retry', user_id: V },
          ],
        });
        flush = f.beacon.flush();
        const deadline = Date.now() + 3000;
        while (true) {
          const waiting =
            await f.sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK} AND NOT granted`;
          if (waiting.length) break;
          if (Date.now() > deadline) throw new Error('sentinel did not wait on advisory lock');
          await Bun.sleep(5);
        }
        if (fail) {
          for (let start = 0; start < 1001; start += 100) {
            await f.post('/events', {
              events: Array.from({ length: Math.min(100, 1001 - start) }, () => ({
                event_type: 'queued',
                user_id: U,
              })),
            });
          }
          await f.post('/events', { events: [{ event_type: 'queued', user_id: V }] });
          expect(f.beacon.stats().buffered).toBe(1002);
        }
        let observed = () => {};
        const operation = new Promise<void>((resolve) => {
          observed = resolve;
        });
        const originalPurge = EventBuffer.prototype.purgeUser;
        const originalFlush = EventBuffer.prototype.flush;
        spies.push(
          spyOn(EventBuffer.prototype, 'purgeUser').mockImplementation(function (userId) {
            observed();
            return originalPurge.call(this, userId);
          }),
        );
        spies.push(
          spyOn(EventBuffer.prototype, 'flush').mockImplementation(function () {
            observed();
            return originalFlush.call(this);
          }),
        );
        let settled = false;
        deletion = f.erase().then((res) => {
          settled = true;
          return res;
        });
        await Promise.race([
          operation,
          Bun.sleep(3000).then(() => {
            throw new Error('handler did not touch buffer');
          }),
        ]);
        await Promise.race([deletion, Bun.sleep(50)]);
        expect(settled).toBe(false);
        await lock`SELECT pg_advisory_unlock(${LOCK})`;
        released = true;
        const res = await deletion;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ count: Number(count) + (fail ? 0 : 1) });
        await flush;
        await f.sql`DROP TRIGGER erasure_block ON beacon_events`;
        await f.sql`DROP FUNCTION erasure_block()`;
        await f.drain();
        expect(await f.sql`SELECT * FROM beacon_events WHERE user_id = ${U}`).toHaveLength(0);
        const kept = await f.sql`SELECT * FROM beacon_events WHERE user_id = ${V}`;
        expect(kept.filter((row) => row.event_type === 'stored')).toEqual(retained);
        expect(kept.map((row) => row.event_type).sort()).toEqual(
          fail ? ['queued', 'retry', 'stored'] : ['retry', 'stored'],
        );
        const audit = await f.sql`SELECT * FROM beacon_erasures`;
        expect(audit).toHaveLength(1);
        expect(audit[0]?.user_id_hash).toBe(HASH);
        expect(Number(audit[0]?.count)).toBe(Number(count) + (fail ? 0 : 1));
        expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(U);
      } finally {
        if (!released) await lock`SELECT pg_advisory_unlock(${LOCK})`;
        lock.release();
        await flush;
        await deletion;
        for (const spy of spies) spy.mockRestore();
        await f.sql`DROP TRIGGER IF EXISTS erasure_block ON beacon_events`;
        await f.sql`DROP FUNCTION IF EXISTS erasure_block()`;
        await f.close();
        for (const log of logs) log.mockRestore();
      }
    }, 15_000);
  }

  for (const target of ['delete', 'audit']) {
    test(`erasure socket ${target} failure rolls back and discards memory`, async () => {
      const f = await fixture();
      const table = target === 'delete' ? 'beacon_events' : 'beacon_erasures';
      const operation = target === 'delete' ? 'DELETE' : 'INSERT';
      const logs = [spyOn(console, 'warn'), spyOn(console, 'error'), spyOn(console, 'log')].map(
        (spy) => spy.mockImplementation(() => {}),
      );
      try {
        await f.post('/events', {
          events: [
            { event_type: 'stored', user_id: U },
            { event_type: 'stored', user_id: V },
          ],
        });
        await f.beacon.flush();
        const original = await f.sql`SELECT * FROM beacon_events ORDER BY event_id`;
        await f.post('/events', {
          events: [
            { event_type: 'queued', user_id: U },
            { event_type: 'queued', user_id: V },
          ],
        });
        await f.sql.unsafe(
          `CREATE FUNCTION erasure_socket_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${U}'; END $$`,
        );
        await f.sql.unsafe(
          `CREATE TRIGGER erasure_socket_fault BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION erasure_socket_fault()`,
        );
        expect((await f.erase()).status).toBe(500);
        expect(await f.sql`SELECT * FROM beacon_events ORDER BY event_id`).toEqual(original);
        expect(await f.sql`SELECT * FROM beacon_erasures`).toHaveLength(0);
        expect(f.beacon.stats().buffered).toBe(1);
        await f.drain();
        expect(await f.sql`SELECT * FROM beacon_events WHERE user_id = ${U}`).toHaveLength(1);
        expect(await f.sql`SELECT * FROM beacon_events WHERE user_id = ${V}`).toHaveLength(2);
        expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(U);
      } finally {
        await f.sql.unsafe(`DROP TRIGGER IF EXISTS erasure_socket_fault ON ${table}`);
        await f.sql`DROP FUNCTION IF EXISTS erasure_socket_fault()`;
        await f.close();
        for (const log of logs) log.mockRestore();
      }
    }, 15_000);
  }

  test('erasure socket auth permits either owner and refuses without changing rows or queue', async () => {
    for (const kind of [
      'admin',
      'trusted',
      'missing',
      'wrong',
      'unconfigured',
      'message',
      'name',
      'getter',
    ]) {
      const f = await fixture({
        trustedIngestToken: kind === 'unconfigured' ? undefined : 'secret',
        isAdmin: () => {
          if (['message', 'name', 'getter'].includes(kind)) {
            const error = new Error(U);
            if (kind === 'name') error.name = U;
            if (kind === 'getter')
              Object.defineProperty(error, 'name', {
                get() {
                  throw new Error(U);
                },
              });
            throw error;
          }
          return kind === 'admin';
        },
      });
      const logs = [spyOn(console, 'warn'), spyOn(console, 'error'), spyOn(console, 'log')].map(
        (spy) => spy.mockImplementation(() => {}),
      );
      try {
        await f.sql`INSERT INTO beacon_events (product_id, event_type, user_id) VALUES ('erase', 'stored', ${U})`;
        await f.post('/events', { events: [{ event_type: 'queued', user_id: U }] });
        const before = f.beacon.stats();
        const original = await f.sql`SELECT * FROM beacon_events ORDER BY event_id`;
        const allowed = ['admin', 'trusted'].includes(kind);
        const res = await f.erase(
          kind === 'trusted' || kind === 'unconfigured'
            ? 'Bearer secret'
            : kind === 'wrong'
              ? 'Bearer wrong'
              : '',
        );
        expect(res.status).toBe(allowed ? 200 : 403);
        if (!allowed) {
          expect(f.beacon.stats()).toEqual(before);
          expect(await f.sql`SELECT * FROM beacon_events ORDER BY event_id`).toEqual(original);
          expect(await f.sql`SELECT * FROM beacon_erasures`).toHaveLength(0);
        }
        expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(U);
      } finally {
        for (const log of logs) log.mockRestore();
        await f.close();
      }
      await f.sql`TRUNCATE beacon_events, beacon_meta`;
    }
  }, 15_000);
});
