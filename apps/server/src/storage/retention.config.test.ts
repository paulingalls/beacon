import { expect, spyOn, test } from 'bun:test';
import type { Sql } from 'postgres';
import { retentionHarness } from '../../test/retentionHarness';
import { createBeacon } from '../createBeacon';
import type { BeaconConfig } from '../types';

const base = {
  productId: 'p',
  postgres: { connectionString: 'postgres://localhost/db' },
  ipMode: 'daily-salt' as const,
};
const sql = Object.assign(() => Promise.resolve({ count: 0 }), {
  end: async () => {},
}) as unknown as Sql;
const invalidDays = [-1, NaN, Infinity, -Infinity, '1', null, 100000001, Number.MAX_VALUE];
const invalidIntervals = [
  0,
  -1,
  1.5,
  2147483648,
  Number.MAX_VALUE,
  NaN,
  Infinity,
  -Infinity,
  '1',
  null,
];

for (const [key, values] of [
  ['retentionDays', invalidDays],
  ['pruneInterval', invalidIntervals],
] as const) {
  for (const value of values) {
    test(`retention ${key === 'pruneInterval' ? 'timer' : 'config'} range refuses ${key}=${value} before resources`, () => {
      const clock = spyOn(Date, 'now').mockReturnValue(0);
      const harness = retentionHarness(sql);
      let saltScheduled = 0;
      try {
        expect(() =>
          createBeacon({ ...base, [key]: value } as BeaconConfig, {
            schedule: () => {
              saltScheduled++;
              return () => {};
            },
          }),
        ).toThrow(key);
        expect(harness.connect).not.toHaveBeenCalled();
        expect(harness.timers).toEqual([]);
        expect(saltScheduled).toBe(0);
      } finally {
        harness.restore();
        clock.mockRestore();
      }
    });
  }
}

for (const retentionDays of [undefined, 0, 0.5, 100000000]) {
  for (const pruneInterval of [1, 2147483647]) {
    test(`retention config range and retention timer range accept days=${retentionDays} interval=${pruneInterval}`, async () => {
      const clock = spyOn(Date, 'now').mockReturnValue(0);
      const harness = retentionHarness(sql);
      let beacon: ReturnType<typeof createBeacon> | undefined;
      try {
        expect(() => {
          beacon = createBeacon({ ...base, retentionDays, pruneInterval });
        }).not.toThrow();
        const timer = harness.timers.find((timer) => timer.delay === pruneInterval);
        expect(Boolean(timer)).toBe(Boolean(retentionDays));
        if (retentionDays) expect(timer?.handle.hasRef()).toBe(false);
      } finally {
        await beacon?.shutdown();
        harness.restore();
        clock.mockRestore();
      }
    });
  }
}

test('retention config range uses computed cutoff rather than a constant day cap', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(86400000);
  const harness = retentionHarness(sql);
  let beacon: ReturnType<typeof createBeacon> | undefined;
  try {
    expect(() => {
      beacon = createBeacon({ ...base, retentionDays: 100000001 });
    }).not.toThrow();
    expect(harness.timers.some((timer) => timer.delay === 86400000)).toBe(true);
  } finally {
    await beacon?.shutdown();
    harness.restore();
    clock.mockRestore();
  }
});

test('retention config range validates each runtime cutoff and recovers on a later tick', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(0);
  let deletes = 0;
  const db = Object.assign(
    () => {
      deletes++;
      return Promise.resolve({ count: 0 });
    },
    { end: async () => {} },
  ) as unknown as Sql;
  const harness = retentionHarness(db);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const beacon = createBeacon({ ...base, retentionDays: 100000000 });
  try {
    const timer = harness.timers.find((timer) => timer.delay === 86400000);
    expect(timer).toBeDefined();
    clock.mockReturnValue(-86400000);
    await timer?.tick();
    expect(deletes).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain('retentionDays');
    clock.mockReturnValue(0);
    await timer?.tick();
    expect(deletes).toBe(1);
  } finally {
    await beacon.shutdown();
    harness.restore();
    warn.mockRestore();
    clock.mockRestore();
  }
});
