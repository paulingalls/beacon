import { expect, spyOn, test } from 'bun:test';
import type { Sql } from 'postgres';
import { retentionHarness } from '../../test/retentionHarness';
import { createBeacon } from '../createBeacon';
import { EventBuffer } from '../events/buffer';

const config = {
  productId: 'p',
  postgres: { connectionString: 'postgres://localhost/db' },
  retentionDays: 1,
  pruneInterval: 1234,
};

function blockedSql() {
  let release!: (value: { count: number }) => void;
  let reject!: (error: Error) => void;
  const blocked = new Promise((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  const calls: string[] = [];
  const sql = Object.assign(
    () => {
      calls.push('delete');
      return calls.length === 1 ? blocked : Promise.resolve({ count: 0 });
    },
    {
      end: async () => {
        calls.push('close');
      },
    },
  ) as unknown as Sql;
  return { sql, calls, release, reject };
}

test('retention shutdown stops immediately, cancels timer and awaits blocked SQL before close', async () => {
  const db = blockedSql();
  const harness = retentionHarness(db.sql);
  let releaseBuffer!: () => void;
  const bufferStop = spyOn(EventBuffer.prototype, 'stop').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseBuffer = resolve;
      }),
  );
  const beacon = createBeacon(config);
  try {
    const timer = harness.timers.find((timer) => timer.delay === 1234);
    expect(timer).toBeDefined();
    const first = timer?.tick();
    let finished = false;
    const stopping = beacon.shutdown().then(() => {
      finished = true;
    });
    await timer?.tick();
    expect(finished).toBe(false);
    expect(db.calls).toEqual(['delete']);
    expect(harness.clear.mock.calls.some(([handle]) => handle === timer?.handle)).toBe(true);
    db.release({ count: 10000 });
    await first;
    await timer?.tick();
    expect(db.calls).toEqual(['delete']);
    releaseBuffer();
    await stopping;
    await timer?.tick();
    expect(db.calls).toEqual(['delete', 'close']);
  } finally {
    bufferStop.mockRestore();
    harness.restore();
  }
});

for (const failure of [false, true]) {
  test(`retention ${failure ? 'failure' : 'overlap'} settles and permits a later run`, async () => {
    const db = blockedSql();
    const harness = retentionHarness(db.sql);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const beacon = createBeacon(config);
    try {
      const timer = harness.timers.find((timer) => timer.delay === 1234);
      expect(timer).toBeDefined();
      const first = timer?.tick();
      void timer?.tick();
      expect(db.calls).toEqual(['delete']);
      if (failure) db.reject(new Error('injected retention SQL failure'));
      else db.release({ count: 0 });
      await expect(Promise.resolve(first)).resolves.toBeUndefined();
      expect(warn.mock.calls.length).toBe(failure ? 1 : 0);
      if (failure)
        expect(String(warn.mock.calls[0]?.[0])).toContain('injected retention SQL failure');
      await timer?.tick();
      expect(db.calls).toEqual(['delete', 'delete']);
    } finally {
      await beacon.shutdown();
      harness.restore();
      warn.mockRestore();
    }
  });
}

for (const failure of [false, true]) {
  test(`retention shutdown awaits SQL settlement with ${failure ? 'rejection' : 'success'}`, async () => {
    const db = blockedSql();
    const harness = retentionHarness(db.sql);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const beacon = createBeacon(config);
    try {
      const timer = harness.timers.find((timer) => timer.delay === 1234);
      expect(timer).toBeDefined();
      void timer?.tick();
      let finished = false;
      const stopping = beacon.shutdown().then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
      expect(db.calls).toEqual(['delete']);
      if (failure) db.reject(new Error('shutdown SQL rejection'));
      else db.release({ count: 10000 });
      await stopping;
      expect(db.calls).toEqual(['delete', 'close']);
      expect(warn.mock.calls.length).toBe(failure ? 1 : 0);
      const clock = spyOn(Date, 'now').mockReturnValue(NaN);
      try {
        await timer?.tick();
        expect(warn.mock.calls.length).toBe(failure ? 1 : 0);
      } finally {
        clock.mockRestore();
      }
    } finally {
      db.release({ count: 0 });
      await beacon.shutdown();
      harness.restore();
      warn.mockRestore();
    }
  });
}
