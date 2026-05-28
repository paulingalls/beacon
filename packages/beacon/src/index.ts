// Public API for @pi-innovations/beacon.

import type { MiddlewareHandler } from 'hono';

import { EventBuffer } from './events/buffer';
import { requestLogger } from './middleware/requestLogger';
import { closeDb, createDb } from './storage/db';
import type { BeaconConfig, BeaconEvent, BufferStats } from './types';

export type { BeaconConfig, BeaconEvent, BufferStats };

/** A configured Beacon instance: middleware plus buffer lifecycle controls. */
export interface Beacon {
  /** Hono middleware that logs every request to the event buffer. */
  middleware(): MiddlewareHandler;
  /** Current event-buffer counters. */
  stats(): BufferStats;
  /** Manually flush one batch of buffered events to Postgres. */
  flush(): Promise<void>;
  /** Drain remaining events, then close the Postgres connection. */
  shutdown(): Promise<void>;
}

/**
 * Create a Beacon: open the Postgres client, start the event buffer, and wire
 * the request-logging middleware (REQUIREMENTS.md §1, PHASE_2 §2.3).
 *
 * Throws on missing required config — the one intentional throw. Runtime failure
 * isolation (§1.3) is handled downstream: createDb never throws and the buffer
 * retries, so a Postgres outage never crashes the host.
 */
export function createBeacon(config: BeaconConfig): Beacon {
  if (!config.productId) {
    throw new Error('[beacon] config.productId is required');
  }
  if (!config.postgres?.connectionString) {
    throw new Error('[beacon] config.postgres.connectionString is required');
  }

  const sql = createDb({
    connectionString: config.postgres.connectionString,
    maxConnections: config.postgres.maxConnections,
  });
  const buffer = new EventBuffer(sql, {
    flushInterval: config.flushInterval,
    maxBatchSize: config.maxBatchSize,
    maxBufferSize: config.maxBufferSize,
  });
  buffer.start();

  const middleware = requestLogger(buffer, {
    productId: config.productId,
    getUserId: config.getUserId,
    excludePaths: config.excludePaths,
    hashIPs: config.hashIPs,
  });

  return {
    middleware: () => middleware,
    stats: () => buffer.stats(),
    flush: () => buffer.flush(),
    shutdown: async () => {
      await buffer.stop();
      await closeDb(sql);
    },
  };
}
