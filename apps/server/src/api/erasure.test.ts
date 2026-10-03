import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';
import { stubSql, withTestDb } from '../../test/helpers';
import { EventBuffer } from '../events/buffer';
import { runMigrations } from '../storage/migrate';
import { type AdminGateOptions, erasureGate } from './auth';
import { createErasureHandler } from './erasure';

const U = 'private/user erasure';
const V = 'retained-user';
const hash = createHash('sha256').update(U).digest('hex');

function appWith(
  sql: Sql,
  buffer: EventBuffer,
  opts: AdminGateOptions & { trustedIngestToken?: string } = { isAdmin: () => true },
) {
  const app = new Hono();
  app.delete('/users/:userId/events', erasureGate(opts), createErasureHandler(sql, buffer));
  return (authorization?: string) =>
    app.request(`/users/${encodeURIComponent(U)}/events`, {
      method: 'DELETE',
      headers: authorization ? { authorization } : {},
    });
}

function captureLogs() {
  const spies = [spyOn(console, 'log'), spyOn(console, 'warn'), spyOn(console, 'error')].map(
    (spy) => spy.mockImplementation(() => {}),
  );
  return {
    assertPrivate: () =>
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(U),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

for (const [name, opts, bearer, allowed] of [
  ['admin', { isAdmin: () => true }, undefined, true],
  ['trusted', { trustedIngestToken: 'secret' }, 'Bearer secret', true],
  ['both', { isAdmin: () => true, trustedIngestToken: 'secret' }, 'Bearer secret', true],
  ['missing', {}, undefined, false],
  ['false admin', { isAdmin: () => false }, undefined, false],
  ['wrong bearer', { trustedIngestToken: 'secret' }, 'Bearer wrong', false],
  ['unconfigured', {}, 'Bearer secret', false],
  ...['message', 'name', 'getter'].map((kind) => [
    kind,
    {
      isAdmin: () => {
        const error = new Error(U);
        if (kind === 'name') error.name = U;
        if (kind === 'getter')
          Object.defineProperty(error, 'name', {
            get() {
              throw new Error(U);
            },
          });
        throw error;
      },
    },
    undefined,
    false,
  ]),
  [
    'trusted with throwing admin',
    {
      trustedIngestToken: 'secret',
      isAdmin: () => {
        throw new Error(U);
      },
    },
    'Bearer secret',
    true,
  ],
] as Array<
  [string, AdminGateOptions & { trustedIngestToken?: string }, string | undefined, boolean]
>) {
  test(`erasure auth ${allowed ? 'permits either owner' : 'refusals preserve database and buffer'}: ${name}`, async () => {
    const written: string[] = [];
    const tx = ((rows: unknown) => {
      if (Array.isArray(rows) && rows[0]?.user_id !== undefined)
        written.push(...rows.map((row) => row.user_id));
      return Promise.resolve(Object.assign([], { count: 0 }));
    }) as unknown as Sql;
    const sql = stubSql({ begin: async (fn) => fn(tx) });
    const buffer = new EventBuffer(sql);
    buffer.push({ productId: 'p', eventType: 'e', userId: U });
    buffer.push({ productId: 'p', eventType: 'e', userId: V });
    const stats = buffer.stats();
    const purge = spyOn(buffer, 'purgeUser');
    const flush = spyOn(buffer, 'flush');
    const begin = spyOn(sql, 'begin');
    const logs = captureLogs();
    try {
      expect((await appWith(sql, buffer, opts)(bearer)).status).toBe(allowed ? 200 : 403);
      if (!allowed) {
        expect(purge).not.toHaveBeenCalled();
        expect(flush).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(buffer.stats()).toEqual(stats);
        await buffer.flush();
        expect(written).toEqual([U, V]);
      }
      logs.assertPrivate();
    } finally {
      purge.mockRestore();
      flush.mockRestore();
      begin.mockRestore();
      logs.restore();
    }
  });
}

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('erasure transaction', () => {
  const getDb = withTestDb(TEST_DB as string);
  beforeEach(async () => {
    await getDb()`TRUNCATE beacon_erasures`;
  });

  async function fixture() {
    const sql = getDb();
    const buffer = new EventBuffer(sql);
    for (const [productId, userId] of [
      ['a', U],
      ['b', U],
      ['a', V],
    ]) {
      buffer.push({ productId: productId as string, userId, eventType: 'seed' });
    }
    await buffer.flush();
    buffer.push({ productId: 'a', eventType: 'queued', userId: U });
    buffer.push({ productId: 'a', eventType: 'queued', userId: V });
    return { sql, buffer, erase: appWith(sql, buffer) };
  }

  test('erasure removes and audits exact stored count; erasure repeat records zero', async () => {
    const { sql, buffer, erase } = await fixture();
    const retained = await sql`SELECT * FROM beacon_events WHERE user_id = ${V}`;
    const logs = captureLogs();
    try {
      const res = await erase();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count: 2 });
      expect(await sql`SELECT * FROM beacon_events WHERE user_id = ${U}`).toHaveLength(0);
      expect([...(await sql`SELECT * FROM beacon_events WHERE user_id = ${V}`)]).toEqual([
        ...retained,
      ]);
      const audit = await sql`SELECT * FROM beacon_erasures`;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.user_id_hash).toBe(hash);
      expect(Number(audit[0]?.count)).toBe(2);
      expect(audit[0]?.erased_at).toBeInstanceOf(Date);
      expect(JSON.stringify(audit)).not.toContain(U);
      await buffer.stop();
      expect(await sql`SELECT * FROM beacon_events WHERE user_id = ${U}`).toHaveLength(0);
      expect(await (await erase()).json()).toEqual({ count: 0 });
      const counts = await sql`SELECT count FROM beacon_erasures ORDER BY count`;
      expect(counts.map((row) => Number(row.count))).toEqual([0, 2]);
      logs.assertPrivate();
    } finally {
      logs.restore();
    }
  });

  for (const target of ['delete', 'audit']) {
    test(`erasure ${target} failure rolls back and keeps memory discarded`, async () => {
      const { sql, buffer, erase } = await fixture();
      const original = await sql`SELECT * FROM beacon_events ORDER BY event_id`;
      const table = target === 'delete' ? 'beacon_events' : 'beacon_erasures';
      const operation = target === 'delete' ? 'DELETE' : 'INSERT';
      await sql.unsafe(
        `CREATE FUNCTION erasure_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${U}'; END $$`,
      );
      await sql.unsafe(
        `CREATE TRIGGER erasure_fault BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION erasure_fault()`,
      );
      const logs = captureLogs();
      try {
        const res = await erase();
        expect(res.status).toBe(500);
        expect([...(await sql`SELECT * FROM beacon_events ORDER BY event_id`)]).toEqual([
          ...original,
        ]);
        expect(await sql`SELECT * FROM beacon_erasures`).toHaveLength(0);
        expect(buffer.stats().buffered).toBe(1);
        logs.assertPrivate();
      } finally {
        logs.restore();
        await sql.unsafe(`DROP TRIGGER erasure_fault ON ${table}`);
        await sql`DROP FUNCTION erasure_fault()`;
      }
      await buffer.stop();
      expect(await sql`SELECT * FROM beacon_events WHERE user_id = ${U}`).toHaveLength(2);
      expect(await (await erase()).json()).toEqual({ count: 2 });
    });
  }

  test('erasure migration rerun preserves audit rows', async () => {
    const sql = getDb();
    await sql`INSERT INTO beacon_erasures (user_id_hash, count) VALUES (${hash}, 7)`;
    const original = await sql`SELECT * FROM beacon_erasures`;
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    expect(await runMigrations(sql)).toContain('003_erasures.sql');
    expect([...(await sql`SELECT * FROM beacon_erasures`)]).toEqual([...original]);
    await sql`TRUNCATE beacon_erasures`;
  });
});

test('erasure purges before transaction; purge failure returns 500 without SQL', async () => {
  const order: string[] = [];
  const sql = stubSql({
    begin: async (fn) => {
      order.push('transaction');
      return fn((() => Promise.resolve(Object.assign([], { count: 0 }))) as unknown as Sql);
    },
  });
  const buffer = new EventBuffer(sql);
  const purge = spyOn(buffer, 'purgeUser').mockImplementation(async () => {
    order.push('purge');
  });
  try {
    expect((await appWith(sql, buffer)()).status).toBe(200);
    expect(order).toEqual(['purge', 'transaction']);
    order.length = 0;
    purge.mockImplementation(async () => {
      throw new Error(U);
    });
    expect((await appWith(sql, buffer)()).status).toBe(500);
    expect(order).toEqual([]);
  } finally {
    purge.mockRestore();
  }
});
