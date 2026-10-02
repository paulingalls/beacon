import type { Sql } from 'postgres';
import type { BeaconConfig } from '../types';

const DAY_MS = 86400000;

function retentionCutoff(days: number): Date {
  const cutoff = new Date(Date.now() - days * DAY_MS);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error('[beacon] retentionDays must produce a representable Date cutoff');
  }
  return cutoff;
}

export function validateRetention(config: BeaconConfig): void {
  const days = config.retentionDays;
  if (days !== undefined) {
    if (!Number.isFinite(days) || days < 0) {
      throw new Error('[beacon] retentionDays must be a finite nonnegative number');
    }
    retentionCutoff(days);
  }
  const interval = config.pruneInterval;
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > 2147483647)
  ) {
    throw new Error(
      '[beacon] pruneInterval must be an integer from 1 through 2147483647 milliseconds',
    );
  }
}

export async function pruneEvents(sql: Sql, days: number, stopped = () => false): Promise<void> {
  const cutoff = retentionCutoff(days);
  while (!stopped()) {
    // Postgres cannot parse every representable JavaScript Date as a timestamp.
    const result = await sql`
      DELETE FROM beacon_events WHERE event_id IN (
        SELECT event_id FROM beacon_events
        WHERE EXTRACT(EPOCH FROM timestamp) * 1000 < ${cutoff.getTime()} LIMIT 10000
      )`;
    if (result.count < 10000) return;
  }
}

export function startPruning(sql: Sql, config: BeaconConfig): { stop(): Promise<void> } {
  const days = config.retentionDays ?? 0;
  let stopped = false;
  let running: Promise<void> | undefined;
  const timer =
    days > 0
      ? setInterval(() => {
          if (stopped || running) return;
          running = pruneEvents(sql, days, () => stopped)
            .catch((error: unknown) => {
              console.warn(`[beacon] retention pruning failed: ${String(error)}`);
            })
            .finally(() => {
              running = undefined;
            });
          return running;
        }, config.pruneInterval ?? DAY_MS)
      : undefined;
  timer?.unref();
  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await running;
    },
  };
}
