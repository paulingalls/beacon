// Public API for @pi-innovations/beacon.

import { type Context, Hono, type MiddlewareHandler } from 'hono';

import { adminGate } from './api/auth';
import { createIngestHandler } from './api/ingest';
import { RateLimiter, rateLimitGate } from './api/rateLimit';
import { EventBuffer } from './events/buffer';
import { track as trackEvent } from './events/track';
import { requestLogger } from './middleware/requestLogger';
import { createAggregateHandler } from './query/aggregate';
import { createAttributionHandler } from './query/attribution';
import { createEventsHandler } from './query/events';
import { createFunnelHandler } from './query/funnel';
import { createSchemaHandler } from './query/schema';
import { closeDb, createDb } from './storage/db';
import type { BeaconConfig, BeaconEvent, BufferStats } from './types';
import { VisitorTokenStore } from './visitors/tokenStore';

/** Query-API rate-limit window: requests/min/user (REQUIREMENTS.md §5.2). */
const QUERY_RATE_WINDOW_MS = 60_000;
const DEFAULT_QUERY_RATE_LIMIT = 60;

export type { BeaconConfig, BeaconEvent, BufferStats };

/** A configured Beacon instance: middleware, visitor helpers, lifecycle controls. */
export interface Beacon {
  /** Configured API mount prefix (default '/analytics'). Mount the router here:
   * `app.route(beacon.basePath, beacon.router())`. */
  basePath: string;
  /** Hono middleware that logs every request and tracks anonymous visitors. */
  middleware(): MiddlewareHandler;
  /**
   * Record a custom product event from a route handler (REQUIREMENTS.md §6.1).
   * Fire-and-forget: buffers the event and returns immediately. Throws only on an
   * invalid event_type (empty/whitespace or >100 chars).
   */
  track(c: Context, eventType: string, properties?: Record<string, unknown>): void;
  /**
   * API router with the client batch-ingest route at `{basePath}/events`
   * (REQUIREMENTS.md §6.2) — public but rate-limited. Mount relative to basePath.
   * Returns the same shared instance on every call (its RateLimiter window
   * persists across requests), so mount it once.
   */
  router(): Hono;
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

  // track() and the ingest endpoint share the request-context/IP config.
  const eventOptions = {
    productId: config.productId,
    getUserId: config.getUserId,
    hashIPs: config.hashIPs,
  };

  // Build the ingest handler + router ONCE so the handler's RateLimiter window
  // persists across requests (a fresh handler per router() call would reset it).
  // The route is relative to basePath; the host mounts the sub-app there.
  const basePath = config.basePath ?? '/analytics';
  const apiRouter = new Hono();
  apiRouter.post('/events', createIngestHandler(buffer, eventOptions));

  // The five read endpoints (REQUIREMENTS.md §5.4), each behind the admin gate
  // (§5.1) and a per-user query rate limiter (§5.2). Built ONCE so the limiter
  // window and the schema property-keys cache persist across requests — a fresh
  // instance per request would reset both. The POST /events ingest route above
  // stays public with its own limiter; query auth/limiting is independent of it.
  const queryLimiter = new RateLimiter({
    limit: config.queryRateLimit ?? DEFAULT_QUERY_RATE_LIMIT,
    windowMs: QUERY_RATE_WINDOW_MS,
  });
  const admin = adminGate({ isAdmin: config.isAdmin });
  const limit = rateLimitGate({
    limiter: queryLimiter,
    getUserId: (c) => config.getUserId?.(c) ?? null,
  });
  apiRouter.get('/schema', admin, limit, createSchemaHandler(sql, { basePath }));
  apiRouter.get('/events', admin, limit, createEventsHandler(sql));
  apiRouter.get('/aggregate', admin, limit, createAggregateHandler(sql));
  apiRouter.get('/funnel', admin, limit, createFunnelHandler(sql));
  apiRouter.get(
    '/attribution',
    admin,
    limit,
    createAttributionHandler(sql, { channelMapping: config.channelMapping }),
  );

  const getVisitorToken = (c: Context): string | null => c.get('beaconVisitorToken') ?? null;

  return {
    basePath,
    middleware: () => middleware,
    track: (c, eventType, properties) => trackEvent(buffer, c, eventOptions, eventType, properties),
    router: () => apiRouter,
    stats: () => buffer.stats(),
    flush: () => buffer.flush(),
    getVisitorToken,
    appendToken: (url, c) => appendToken(url, getVisitorToken(c)),
    associateVisitor: async (c, userId) => {
      // Persist any buffered trail before the UPDATE: a login within the flush
      // window would otherwise miss still-buffered events (and store.remove
      // would drop their first-touch attribution permanently). A single flush()
      // drains one batch, so drain in a bounded loop to cover a multi-batch
      // backlog. The cap bounds login latency, and the no-progress break stops
      // spinning when writes are failing/backpressured (Postgres down).
      await drainBuffer(buffer);
      await associateVisitor(sql, tokenStore, getVisitorToken(c), userId);
    },
    shutdown: async () => {
      tokenStore.stop();
      await buffer.stop();
      await closeDb(sql);
    },
  };
}

/** Max flush passes when draining before association — bounds login latency. */
const MAX_DRAIN_PASSES = 10;

/**
 * Flush the buffer to (near-)empty before association so the visitor trail is on
 * disk. flush() drains one batch; loop for a multi-batch backlog, capped, and
 * stop early when a pass makes no progress (writes failing/backpressured).
 */
async function drainBuffer(buffer: EventBuffer): Promise<void> {
  let remaining = buffer.stats().buffered;
  for (let pass = 0; pass < MAX_DRAIN_PASSES && remaining > 0; pass++) {
    await buffer.flush();
    const next = buffer.stats().buffered;
    if (next >= remaining) break; // no progress — don't spin
    remaining = next;
  }
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
 * Associate an anonymous trail with a user (§2.4). The two UPDATEs run in one
 * transaction for all-or-nothing semantics: the `user_id IS NULL` guard keeps
 * the back-fill idempotent (re-runs never clobber an already-associated event),
 * and attribution lands on the earliest event only when the token record carries
 * it — so a partial failure can't leave the trail associated yet attribution
 * lost. The token is removed only after the commit; on any failure it is
 * retained so a retry can re-run cleanly. Wrapped so a Postgres outage during
 * login can never crash the host (§1.3). Only persisted events are updated; the
 * caller flushes the buffer first so the trail is on disk.
 */
async function associateVisitor(
  sql: ReturnType<typeof createDb>,
  store: VisitorTokenStore,
  token: string | null,
  userId: string,
): Promise<void> {
  if (!token) return; // direct login, no anonymous trail
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE beacon_events SET user_id = ${userId}
        WHERE visitor_token = ${token} AND user_id IS NULL`;

      const record = store.get(token);
      if (record?.attribution) {
        await tx`
          UPDATE beacon_events SET attribution = ${tx.json(record.attribution)}
          WHERE event_id = (
            SELECT event_id FROM beacon_events
            WHERE visitor_token = ${token}
            ORDER BY timestamp ASC, received_at ASC
            LIMIT 1
          )`;
      }
    });
    store.remove(token);
  } catch (err) {
    console.warn(`[beacon] associateVisitor failed: ${String(err)}`);
  }
}
