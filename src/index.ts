// Public API for @pi-innovations/beacon.

import type { Context, MiddlewareHandler } from 'hono';

import { EventBuffer } from './events/buffer';
import { requestLogger } from './middleware/requestLogger';
import { closeDb, createDb } from './storage/db';
import type { BeaconConfig, BeaconEvent, BufferStats } from './types';
import { VisitorTokenStore } from './visitors/tokenStore';

export type { BeaconConfig, BeaconEvent, BufferStats };

/** A configured Beacon instance: middleware, visitor helpers, lifecycle controls. */
export interface Beacon {
  /** Hono middleware that logs every request and tracks anonymous visitors. */
  middleware(): MiddlewareHandler;
  /** Current event-buffer counters. */
  stats(): BufferStats;
  /** Manually flush one batch of buffered events to Postgres. */
  flush(): Promise<void>;
  /** The current request's visitor token (set by the middleware), or null. */
  getVisitorToken(c: Context): string | null;
  /** Append `?_t=`/`&_t=` to a URL using the context token (no-op without one). */
  appendToken(url: string, c: Context): string;
  /**
   * Link the anonymous visitor trail to an authenticated user (REQUIREMENTS.md
   * §2.4): back-fill user_id on the trail, copy first-touch attribution onto the
   * earliest event, and drop the token. Best-effort — never throws (§1.3).
   */
  associateVisitor(c: Context, userId: string): Promise<void>;
  /** Drain remaining events, stop the token sweep, and close Postgres. */
  shutdown(): Promise<void>;
}

/**
 * Create a Beacon: open the Postgres client, start the event buffer + visitor
 * token store, and wire the request-logging middleware (REQUIREMENTS.md §1–§3).
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

  const tokenStore = new VisitorTokenStore({
    ttl: config.visitorTokenTTL,
    maxEntries: config.maxVisitorTokens,
  });

  const middleware = requestLogger(buffer, {
    productId: config.productId,
    getUserId: config.getUserId,
    excludePaths: config.excludePaths,
    hashIPs: config.hashIPs,
    tokenStore,
  });

  const getVisitorToken = (c: Context): string | null => c.get('beaconVisitorToken') ?? null;

  return {
    middleware: () => middleware,
    stats: () => buffer.stats(),
    flush: () => buffer.flush(),
    getVisitorToken,
    appendToken: (url, c) => appendToken(url, getVisitorToken(c)),
    associateVisitor: async (c, userId) => {
      // Persist any buffered trail before the UPDATE: a login within the flush
      // window would otherwise miss still-buffered events (and store.remove
      // would drop their first-touch attribution permanently). flush() drains
      // one batch (maxBatchSize); a >batch backlog could leave a tail, which
      // the next timer flush picks up but after this association runs.
      await buffer.flush();
      await associateVisitor(sql, tokenStore, getVisitorToken(c), userId);
    },
    shutdown: async () => {
      tokenStore.stop();
      await buffer.stop();
      await closeDb(sql);
    },
  };
}

/** Append the visitor token to a URL, preserving any `#fragment` (§2.3). */
function appendToken(url: string, token: string | null): string {
  if (!token) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  // Idempotent: a URL that already carries a `_t` param is returned unchanged.
  // Appending a second `_t` would make the framework pick one arbitrarily and
  // split the visitor trail, so we never double-apply.
  if (/[?&]_t=/.test(base)) return url;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}_t=${token}${fragment}`;
}

/**
 * Associate an anonymous trail with a user (§2.4). Two independent UPDATEs: the
 * `user_id IS NULL` guard makes the first idempotent (re-runs are no-ops and
 * never clobber an already-associated event), and attribution lands on the
 * earliest event only when the token record carries it. Wrapped so a Postgres
 * outage during login can never crash the host (§1.3). Only persisted events are
 * updated; the caller flushes the buffer first so the trail is on disk.
 */
async function associateVisitor(
  sql: ReturnType<typeof createDb>,
  store: VisitorTokenStore,
  token: string | null,
  userId: string,
): Promise<void> {
  if (!token) return; // direct login, no anonymous trail
  try {
    await sql`
      UPDATE beacon_events SET user_id = ${userId}
      WHERE visitor_token = ${token} AND user_id IS NULL`;

    const record = store.get(token);
    if (record?.attribution) {
      await sql`
        UPDATE beacon_events SET attribution = ${sql.json(record.attribution)}
        WHERE event_id = (
          SELECT event_id FROM beacon_events
          WHERE visitor_token = ${token}
          ORDER BY timestamp ASC, received_at ASC
          LIMIT 1
        )`;
    }
    store.remove(token);
  } catch (err) {
    console.warn(`[beacon] associateVisitor failed: ${String(err)}`);
  }
}
