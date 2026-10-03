import { spyOn } from 'bun:test';
import type { Sql } from 'postgres';
import * as db from '../src/storage/db';

export function retentionHarness(sql: Sql) {
  const nativeInterval = globalThis.setInterval;
  const timers: Array<{
    delay: number;
    tick: () => unknown;
    handle: ReturnType<typeof setInterval>;
  }> = [];
  const schedule = spyOn(globalThis, 'setInterval').mockImplementation(((
    tick: () => unknown,
    delay: number,
  ) => {
    const handle = nativeInterval(() => {}, delay);
    timers.push({ delay, tick, handle });
    return handle;
  }) as typeof setInterval);
  const connect = spyOn(db, 'createDb').mockReturnValue(sql);
  const clear = spyOn(globalThis, 'clearInterval');
  return {
    timers,
    connect,
    clear,
    restore() {
      for (const timer of timers) clearInterval(timer.handle);
      schedule.mockRestore();
      connect.mockRestore();
      clear.mockRestore();
    },
  };
}

export function recordingSql(sql: Sql, observe: (query: string, values: unknown[]) => void): Sql {
  return new Proxy(sql, {
    apply(target, receiver, args) {
      observe(Array.isArray(args[0]) ? args[0].join('?') : '', args.slice(1));
      return Reflect.apply(target, receiver, args);
    },
  });
}
