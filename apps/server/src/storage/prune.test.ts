import { describe, expect, spyOn, test } from 'bun:test';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';
import { withTestDb } from '../../test/helpers';
import { recordingSql, retentionHarness } from '../../test/retentionHarness';
import { createBeacon } from '../createBeacon';
import { buildServer } from '../server';
import { pruneEvents } from './prune';

registerDbCoverageGuard();
const day = 86400000;
const epoch = Date.UTC(2026, 0, 10);
const config = { productId: 'p', postgres: { connectionString: TEST_DB as string } };

describe.skipIf(!TEST_DB)('retention live SQL', () => {
  const getSql = withTestDb(TEST_DB as string);

  test('retention batches preserve complete protected rows and one strict event cutoff', async () => {
    const sql = getSql();
    const clock = spyOn(Date, 'now').mockReturnValue(epoch);
    const cutoff = new Date(epoch - day);
    await sql`TRUNCATE beacon_short_links, beacon_erasures`;
    await sql`INSERT INTO beacon_meta VALUES ('p', 'old', ${cutoff}, ${cutoff}, 51)`;
    await sql`INSERT INTO beacon_short_links VALUES ('retention', 'https://example.com', 'p', '{"source":"x"}', ${cutoff}, ${cutoff}, 9)`;
    await sql`INSERT INTO beacon_erasures VALUES ('sentinel', 7, ${cutoff})`;
    const snapshot = async () => [
      [...(await sql`SELECT * FROM beacon_meta ORDER BY product_id, event_type`)],
      [...(await sql`SELECT * FROM beacon_short_links ORDER BY code`)],
      [...(await sql`SELECT * FROM beacon_erasures ORDER BY user_id_hash`)],
    ];
    const before = await snapshot();
    await sql`INSERT INTO beacon_events (product_id, timestamp, received_at, event_type)
      SELECT CASE WHEN n % 2 = 0 THEN 'p' ELSE 'other' END, ${new Date(epoch - 2 * day)}, ${new Date(epoch)}, 'old'
      FROM generate_series(1, 20001) n`;
    await sql`INSERT INTO beacon_events (product_id, timestamp, received_at, event_type) VALUES
      ('p', ${cutoff}, ${new Date(epoch - 2 * day)}, 'equal'),
      ('p', ${new Date(+cutoff + 1)}, ${new Date(epoch - 2 * day)}, 'newer')`;
    const counts: number[] = [];
    const cutoffs: unknown[] = [];
    const wrapped = new Proxy(sql, {
      apply(target, receiver, args) {
        return (async () => {
          const result = await Reflect.apply(target, receiver, args);
          counts.push(result.count);
          cutoffs.push(args[1]);
          clock.mockReturnValue(epoch + day);
          return result;
        })();
      },
    }) as Sql;
    try {
      await pruneEvents(wrapped, 1);
      expect([...(await sql`SELECT event_type FROM beacon_events ORDER BY event_type`)]).toEqual([
        { event_type: 'equal' },
        { event_type: 'newer' },
      ]);
      expect(await snapshot()).toEqual(before);
      expect(counts).toEqual([10000, 10000, 1]);
      expect(cutoffs).toEqual([cutoff, cutoff, cutoff]);
    } finally {
      clock.mockRestore();
      await sql`TRUNCATE beacon_short_links, beacon_erasures`;
    }
  });

  for (const path of ['factory', 'env']) {
    for (const days of [undefined, 0, 0.5]) {
      test(`retention ${path === 'env' ? 'env' : days ? 'timer' : 'disabled'} ${path} days=${days}`, async () => {
        const sql = getSql();
        await sql`INSERT INTO beacon_events (product_id, timestamp, event_type) VALUES
          ('p', ${new Date(epoch - 500 * day)}, 'ancient'),
          ('p', ${new Date(epoch - day / 4)}, 'recent'),
          ('other', ${new Date(epoch - day * 0.75)}, 'middle')`;
        const clock = spyOn(Date, 'now').mockReturnValue(epoch);
        const deletes: string[] = [];
        const harness = retentionHarness(
          recordingSql(sql, (query) => {
            if (/DELETE/i.test(query)) deletes.push(query);
          }),
        );
        // The verifier connection must remain open for independent SELECTs.
        const end = spyOn(sql, 'end').mockResolvedValue();
        let beacon: ReturnType<typeof createBeacon> | undefined;
        try {
          beacon =
            path === 'factory'
              ? createBeacon({ ...config, retentionDays: days })
              : buildServer({
                  DATABASE_URL: TEST_DB,
                  RETENTION_DAYS: days === undefined ? undefined : String(days),
                }).beacon;
          for (let i = 0; i < 3; i++) {
            for (const timer of harness.timers.filter((timer) => timer.delay === day))
              await timer.tick();
            if (days && i === 0) {
              expect(
                (await sql`SELECT event_type FROM beacon_events`).map((row) => row.event_type),
              ).toEqual(['recent']);
            }
            clock.mockReturnValue(epoch + (i + 1) * day);
          }
          const rows = await sql`SELECT event_type FROM beacon_events ORDER BY event_type`;
          expect(rows.map((row) => row.event_type)).toEqual(
            days ? [] : ['ancient', 'middle', 'recent'],
          );
          if (days) {
            expect(deletes.length).toBe(3);
            expect(harness.timers.find((timer) => timer.delay === day)?.handle.hasRef()).toBe(
              false,
            );
          } else expect(deletes).toEqual([]);
        } finally {
          await beacon?.shutdown();
          end.mockRestore();
          harness.restore();
          clock.mockRestore();
        }
      });
    }
  }
});
